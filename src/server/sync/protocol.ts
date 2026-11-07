import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z, ZodError } from "zod";
import { ForbiddenError } from "../authz/permissions";
import type { Database } from "../db/client";
import { setTenantContext } from "../db/context";
import { syncOperations } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import { OPERATION_KINDS, type OperationKind, type OperationOutcome } from "../../lib/sync/protocol";
import type { TenantContext } from "../tenancy/service";

/**
 * The sync protocol (generalised from offline registers, phase H). A device sends changes as operations:
 *
 *   { id: <UUID chosen by the device>, kind, payload, recordedAt? }
 *
 * Each operation is applied by its kind's handler, which calls the same service as the web screens, so
 * permissions, plan features, campus scope, validation, audit and locks are unchanged. It is recorded in
 * `sync_operations` in the SAME transaction as its effects (the service's own transaction becomes a
 * savepoint), so an operation either applies and is recorded, or neither; sending it again (a retry after
 * a lost answer, two tabs, a restarted device) returns the recorded outcome and changes nothing.
 *
 * Outcomes:
 * - applied: done (the result says what was saved);
 * - conflict: someone else changed the same thing since the device read it, or a check needs a person
 *   (e.g. a possible duplicate student); nothing conflicting was overwritten. The device shows both sides
 *   and, to go ahead, sends a NEW operation (a new id) built from the person's decision;
 * - rejected: it can never apply as sent (not allowed, invalid, locked); the device should drop it and say why.
 *
 * Operations are applied in order, one transaction each, so earlier ones stay applied if a later one fails.
 * Last-writer-wins is never used.
 */

export { OPERATION_KINDS, type OperationKind, type OperationOutcome } from "../../lib/sync/protocol";

export const MAX_OPERATIONS_PER_BATCH = 100;

export const operationSchema = z.object({
  id: z.string().uuid("Each operation needs a UUID chosen by the device."),
  kind: z.enum(OPERATION_KINDS),
  payload: z.unknown(),
  /** When the change was made on the device (ISO), for changes sent after being offline. */
  recordedAt: z.string().datetime({ offset: true }).optional(),
});

export const batchSchema = z.object({
  operations: z.array(operationSchema).min(1).max(MAX_OPERATIONS_PER_BATCH),
});

export type Operation = z.infer<typeof operationSchema>;

export type HandlerResult =
  | { status: "applied"; result: Record<string, unknown> }
  | { status: "conflict"; result: Record<string, unknown> };

/** Applies one operation with `database`, which is the operation's open transaction. */
export type OperationHandler = (
  database: Database,
  ctx: TenantContext,
  payload: unknown,
  op: Operation,
) => Promise<HandlerResult>;

/** Failures that will happen again however often the operation is sent. */
function rejection(
  error: unknown,
): { code: string; message: string; fields?: Record<string, string> } | null {
  if (error instanceof DomainError)
    return {
      code: error.code,
      message: error.message,
      ...(error.field ? { fields: { [error.field]: error.message } } : {}),
    };
  if (error instanceof ForbiddenError)
    return { code: "forbidden", message: "You do not have permission to do this." };
  if (error instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of error.issues) fields[issue.path.join(".") || "_"] ??= issue.message;
    return { code: "invalid_input", message: "Some fields are not valid.", fields };
  }
  return null;
}

type Stored = typeof syncOperations.$inferSelect;

function fromStored(row: Stored, replayed: boolean): OperationOutcome {
  const kind = row.kind as OperationKind;
  const outcome = row.outcome ?? {};
  return row.status === "rejected"
    ? {
        id: row.id,
        kind,
        status: "rejected",
        error: outcome as OperationOutcome & { code: string; message: string },
        replayed,
      }
    : { id: row.id, kind, status: row.status, result: outcome, replayed };
}

async function applyOne(
  database: Database,
  ctx: TenantContext,
  op: Operation,
  handlers: Record<OperationKind, OperationHandler>,
): Promise<OperationOutcome> {
  const scope = { tenantId: ctx.tenant.id, userId: ctx.userId, supportGrantId: ctx.support?.grantId };
  const find = (tx: Pick<Database, "select">) =>
    tx
      .select()
      .from(syncOperations)
      .where(and(eq(syncOperations.tenantId, ctx.tenant.id), eq(syncOperations.id, op.id)));
  try {
    return await database.transaction(async (tx) => {
      await setTenantContext(tx, scope);
      // The same operation arriving twice at once waits here, then finds the first one's outcome.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`sync:${ctx.tenant.id}:${op.id}`}, 0))`,
      );
      const [existing] = await find(tx);
      if (existing) {
        if (existing.userId !== ctx.userId || existing.kind !== op.kind)
          return {
            id: op.id,
            kind: op.kind,
            status: "rejected" as const,
            error: {
              code: "operation_id_reused",
              message: "This operation id was already used for something else.",
            },
            replayed: false,
          };
        return fromStored(existing, true);
      }
      let status: Stored["status"];
      let outcome: Record<string, unknown>;
      try {
        // Services open their own transaction, which here becomes a savepoint of this one.
        const done = await handlers[op.kind](tx as unknown as Database, ctx, op.payload, op);
        status = done.status;
        outcome = done.result;
      } catch (error) {
        const reason = rejection(error);
        if (!reason) throw error;
        status = "rejected";
        outcome = reason;
      }
      const [row] = await tx
        .insert(syncOperations)
        .values({
          tenantId: ctx.tenant.id,
          id: op.id,
          userId: ctx.userId,
          kind: op.kind,
          status,
          outcome: JSON.parse(JSON.stringify(outcome)) as Record<string, unknown>,
          recordedAt: op.recordedAt ? new Date(op.recordedAt) : null,
        })
        .returning();
      return fromStored(row!, false);
    });
  } catch (error) {
    // Lost a race with the same operation on another connection: its outcome stands.
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
      const [row] = await database.transaction(async (tx) => {
        await setTenantContext(tx, scope);
        return find(tx);
      });
      if (row) return fromStored(row, true);
    }
    throw error;
  }
}

/** Applies a batch of operations from a device, in order. */
export async function applyOperations(
  database: Database,
  ctx: TenantContext,
  input: unknown,
  handlers: Record<OperationKind, OperationHandler>,
): Promise<OperationOutcome[]> {
  const { operations } = batchSchema.parse(input);
  const ids = new Set<string>();
  const outcomes: OperationOutcome[] = [];
  for (const op of operations) {
    if (ids.has(op.id))
      throw new DomainError("operation_repeated", "The same operation appears twice in this batch.");
    ids.add(op.id);
    outcomes.push(await applyOne(database, ctx, op, handlers));
  }
  return outcomes;
}
