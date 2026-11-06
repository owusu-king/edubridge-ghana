import "server-only";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { ReportCardSnapshot } from "../../lib/assessment";
import { recordAudit } from "../audit/record";
import { assertCan } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  classes,
  reportCardBatches,
  reportCardFiles,
  reportCards,
  tenants,
  terms,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { listAssessableClasses, loadTerm, seesAllClasses } from "./access";
import { classStudents } from "./class-data";

/** Renders report cards, in order, into one PDF (supplied by the web layer, which owns the PDF templates). */
export type RenderReportCards = (snapshots: ReportCardSnapshot[]) => Promise<Buffer>;

const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenant.id, userId: ctx.userId });
/** How long a worker holds a batch before another may take it over (renewed after every class). */
const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
export const BATCH_RETENTION_MS = 7 * 86_400_000;

/**
 * Asks for the published report cards of some classes to be printed. Returns at once; the PDFs are made in
 * the background, one per class.
 */
export async function requestReportCardPrint(
  database: Database,
  ctx: TenantContext,
  termId: string,
  input: unknown,
): Promise<string> {
  assertCan(ctx.roles, "assessment.enter");
  const { classIds } = z
    .object({ classIds: z.array(z.string().uuid()).min(1, "Choose at least one class.").max(200) })
    .parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTerm(tx, ctx.tenant.id, termId);
    if (!term) throw new DomainError("term_not_found", "Term not found.");
    const reachable = new Set((await listAssessableClasses(tx, ctx)).map((c) => c.id));
    const wanted = [...new Set(classIds)];
    if (wanted.some((id) => !reachable.has(id))) throw new DomainError("class_not_found", "Class not found.");
    const [published] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(reportCards)
      .where(
        and(
          eq(reportCards.tenantId, ctx.tenant.id),
          eq(reportCards.termId, term.id),
          eq(reportCards.status, "published"),
        ),
      );
    if (!published?.n)
      throw new DomainError("nothing_published", "No report cards are published for this term yet.");
    const [batch] = await tx
      .insert(reportCardBatches)
      .values({ tenantId: ctx.tenant.id, termId: term.id, classIds: wanted, requestedByUserId: ctx.userId })
      .returning({ id: reportCardBatches.id });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "report_cards.print_requested",
      entityType: "report_card_batch",
      entityId: batch!.id,
      metadata: { term: term.name, classes: wanted.length },
    });
    return batch!.id;
  });
}

export interface BatchView {
  id: string;
  termName: string;
  status: "queued" | "running" | "done" | "failed";
  classCount: number;
  requestedBy: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  files: { id: string; className: string; reportCount: number; byteSize: number }[];
}

/** Recent print runs: everyone's for academic leads, a teacher's own otherwise. */
export async function listReportCardBatches(database: Database, ctx: TenantContext): Promise<BatchView[]> {
  assertCan(ctx.roles, "assessment.enter");
  return withTenant(database, scope(ctx), async (tx) => {
    const rows = await tx
      .select({
        id: reportCardBatches.id,
        termName: terms.name,
        status: reportCardBatches.status,
        classIds: reportCardBatches.classIds,
        requestedBy: users.name,
        createdAt: reportCardBatches.createdAt,
        finishedAt: reportCardBatches.finishedAt,
      })
      .from(reportCardBatches)
      .innerJoin(terms, eq(terms.id, reportCardBatches.termId))
      .leftJoin(users, eq(users.id, reportCardBatches.requestedByUserId))
      .where(
        and(
          eq(reportCardBatches.tenantId, ctx.tenant.id),
          seesAllClasses(ctx) && ctx.campusIds === null
            ? undefined
            : eq(reportCardBatches.requestedByUserId, ctx.userId),
        ),
      )
      .orderBy(desc(reportCardBatches.createdAt))
      .limit(20);
    const files = rows.length
      ? await tx
          .select({
            id: reportCardFiles.id,
            batchId: reportCardFiles.batchId,
            className: reportCardFiles.className,
            reportCount: reportCardFiles.reportCount,
            byteSize: reportCardFiles.byteSize,
          })
          .from(reportCardFiles)
          .where(
            and(
              eq(reportCardFiles.tenantId, ctx.tenant.id),
              inArray(
                reportCardFiles.batchId,
                rows.map((r) => r.id),
              ),
            ),
          )
          .orderBy(asc(reportCardFiles.className))
      : [];
    return rows.map((r) => ({
      id: r.id,
      termName: r.termName,
      status: r.status,
      classCount: r.classIds.length,
      requestedBy: r.requestedBy,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      files: files.filter((f) => f.batchId === r.id).map(({ batchId: _b, ...f }) => f),
    }));
  });
}

/** A printed class file, if this member can see its print run. */
export async function getReportCardFile(
  database: Database,
  ctx: TenantContext,
  fileId: string,
): Promise<{ pdf: Buffer; filename: string } | null> {
  assertCan(ctx.roles, "assessment.enter");
  if (!z.string().uuid().safeParse(fileId).success) return null;
  return withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .select({
        pdf: reportCardFiles.pdf,
        className: reportCardFiles.className,
        termName: terms.name,
        requestedBy: reportCardBatches.requestedByUserId,
      })
      .from(reportCardFiles)
      .innerJoin(reportCardBatches, eq(reportCardBatches.id, reportCardFiles.batchId))
      .innerJoin(terms, eq(terms.id, reportCardBatches.termId))
      .where(and(eq(reportCardFiles.tenantId, ctx.tenant.id), eq(reportCardFiles.id, fileId)));
    if (!row?.pdf) return null;
    if (!(seesAllClasses(ctx) && ctx.campusIds === null) && row.requestedBy !== ctx.userId) return null;
    return { pdf: row.pdf, filename: `report-cards-${row.className}-${row.termName}.pdf` };
  });
}

/** Takes the next batch that is waiting, or whose worker stopped renewing its lease. */
async function claimBatch(tx: Transaction, tenantId: string, batchId?: string) {
  const [row] = await tx
    .select({ id: reportCardBatches.id })
    .from(reportCardBatches)
    .where(
      and(
        eq(reportCardBatches.tenantId, tenantId),
        batchId ? eq(reportCardBatches.id, batchId) : undefined,
        or(
          eq(reportCardBatches.status, "queued"),
          and(eq(reportCardBatches.status, "running"), lt(reportCardBatches.lockedUntil, new Date())),
        ),
      ),
    )
    .orderBy(asc(reportCardBatches.createdAt))
    .limit(1)
    .for("update", { skipLocked: true });
  if (!row) return null;
  const [claimed] = await tx
    .update(reportCardBatches)
    .set({
      status: "running",
      attempts: sql`${reportCardBatches.attempts} + 1`,
      lockedUntil: new Date(Date.now() + LEASE_MS),
    })
    .where(eq(reportCardBatches.id, row.id))
    .returning();
  return claimed!;
}

/**
 * Prints one waiting batch for a school (a given one, or the oldest): class by class, each in its own
 * transaction, so a crash resumes after the last finished class. Returns the number of classes printed.
 */
export async function processReportCardBatch(
  database: Database,
  tenantId: string,
  render: RenderReportCards,
  batchId?: string,
): Promise<{ batchId: string; classes: number } | null> {
  const system = { tenantId, userId: "" };
  const batch = await withTenant(database, system, (tx) => claimBatch(tx, tenantId, batchId));
  if (!batch) return null;
  if (batch.attempts > MAX_ATTEMPTS) {
    await withTenant(database, system, (tx) =>
      tx
        .update(reportCardBatches)
        .set({
          status: "failed",
          error: "Stopped after repeated failures.",
          finishedAt: new Date(),
          lockedUntil: null,
        })
        .where(eq(reportCardBatches.id, batch.id)),
    );
    return { batchId: batch.id, classes: 0 };
  }
  let printed = 0;
  try {
    for (const classId of batch.classIds) {
      // Read in one transaction, render outside it (rendering takes seconds), store in another.
      const work = await withTenant(database, system, async (tx) => {
        const [existing] = await tx
          .select({ id: reportCardFiles.id })
          .from(reportCardFiles)
          .where(and(eq(reportCardFiles.batchId, batch.id), eq(reportCardFiles.classId, classId)));
        if (existing) return null;
        const [cls] = await tx
          .select({ name: classes.name })
          .from(classes)
          .where(and(eq(classes.tenantId, tenantId), eq(classes.id, classId)));
        // Students in the class this term, in class-list order; only published report cards print.
        const roster = await classStudents(tx, tenantId, batch.termId, classId);
        const cards = roster.length
          ? await tx
              .select({ studentId: reportCards.studentId, snapshot: reportCards.snapshot })
              .from(reportCards)
              .where(
                and(
                  eq(reportCards.tenantId, tenantId),
                  eq(reportCards.termId, batch.termId),
                  eq(reportCards.status, "published"),
                  inArray(
                    reportCards.studentId,
                    roster.map((s) => s.id),
                  ),
                ),
              )
          : [];
        const byStudent = new Map(cards.map((c) => [c.studentId, c.snapshot!]));
        return {
          className: cls?.name ?? "Class",
          snapshots: roster.flatMap((s) => (byStudent.has(s.id) ? [byStudent.get(s.id)!] : [])),
        };
      });
      if (!work) continue;
      const pdf = work.snapshots.length ? await render(work.snapshots) : null;
      const done = await withTenant(database, system, async (tx) => {
        const inserted = await tx
          .insert(reportCardFiles)
          .values({
            tenantId,
            batchId: batch.id,
            classId,
            className: work.className,
            reportCount: work.snapshots.length,
            pdf,
            sha256: pdf ? createHash("sha256").update(pdf).digest("hex") : null,
            byteSize: pdf?.length ?? 0,
          })
          .onConflictDoNothing()
          .returning({ id: reportCardFiles.id });
        await tx
          .update(reportCardBatches)
          .set({ lockedUntil: new Date(Date.now() + LEASE_MS) })
          .where(eq(reportCardBatches.id, batch.id));
        return inserted.length > 0;
      });
      if (done) printed++;
    }
    await withTenant(database, system, (tx) =>
      tx
        .update(reportCardBatches)
        .set({ status: "done", finishedAt: new Date(), lockedUntil: null, error: null })
        .where(eq(reportCardBatches.id, batch.id)),
    );
  } catch (error) {
    // Leave it running with an expired lease, so the next worker cycle retries from the last class.
    await withTenant(database, system, (tx) =>
      tx
        .update(reportCardBatches)
        .set({
          lockedUntil: new Date(),
          error: error instanceof Error ? error.message.slice(0, 500) : "Failed.",
        })
        .where(eq(reportCardBatches.id, batch.id)),
    );
    throw error;
  }
  return { batchId: batch.id, classes: printed };
}

/** Worker: prints waiting batches at every active school and removes print runs older than 7 days. */
export async function runReportCardWork(
  database: Database,
  render: RenderReportCards,
): Promise<{ batches: number; classes: number; removed: number; errors: number }> {
  const total = { batches: 0, classes: 0, removed: 0, errors: 0 };
  const schools = await database.select({ id: tenants.id }).from(tenants).where(eq(tenants.status, "active"));
  for (const school of schools) {
    try {
      for (let i = 0; i < 5; i++) {
        const done = await processReportCardBatch(database, school.id, render);
        if (!done) break;
        total.batches++;
        total.classes += done.classes;
      }
    } catch (error) {
      total.errors++;
      console.error("report card printing failed", error instanceof Error ? error.message : error);
    }
    const removed = await withTenant(database, { tenantId: school.id, userId: "" }, (tx) =>
      tx
        .delete(reportCardBatches)
        .where(
          and(
            eq(reportCardBatches.tenantId, school.id),
            lt(reportCardBatches.createdAt, new Date(Date.now() - BATCH_RETENTION_MS)),
          ),
        )
        .returning({ id: reportCardBatches.id }),
    );
    total.removed += removed.length;
  }
  return total;
}
