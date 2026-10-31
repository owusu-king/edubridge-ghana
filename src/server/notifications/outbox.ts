import "server-only";
import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { Database, Queryable } from "../db/client";
import { notificationOutbox } from "../db/schema";
import { DeliveryError, providersFromEnv, type Providers } from "./providers";
import { isTemplate, TEMPLATES, type TemplateName } from "./templates";

export const MAX_ATTEMPTS = 5;

export interface EnqueueInput<T extends TemplateName> {
  channel: "email";
  recipient: string;
  template: T;
  payload: Parameters<(typeof TEMPLATES)[T]>[0];
}

/** Queues a message in the caller's transaction, so it is sent if and only if the change commits. */
export async function enqueue<T extends TemplateName>(
  db: Queryable,
  input: EnqueueInput<T>,
): Promise<string> {
  const [row] = await db
    .insert(notificationOutbox)
    .values({
      channel: input.channel,
      recipient: input.recipient,
      template: input.template,
      payload: input.payload as Record<string, unknown>,
    })
    .returning({ id: notificationOutbox.id });
  return row!.id;
}

/** Exponential backoff: 1, 2, 4, 8 minutes. */
const backoffMs = (attempts: number) => 60_000 * 2 ** Math.max(0, attempts - 1);

/**
 * Claims due messages (SKIP LOCKED, so several dispatchers never send the same message), sends them,
 * and records the outcome. Payloads are cleared after sending; failures keep only a safe error message.
 */
export async function dispatchPending(
  database: Database,
  opts: { limit?: number; providers?: Providers; now?: Date } = {},
): Promise<{ sent: number; failed: number }> {
  const now = opts.now ?? new Date();
  const providers = opts.providers ?? providersFromEnv();
  const claimed = await database.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(notificationOutbox)
      .where(and(eq(notificationOutbox.status, "pending"), lte(notificationOutbox.nextAttemptAt, now)))
      .orderBy(notificationOutbox.createdAt)
      .limit(opts.limit ?? 20)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    await tx
      .update(notificationOutbox)
      // nextAttemptAt doubles as the claim time while sending (used by releaseStuck).
      .set({ status: "sending", attempts: sql`${notificationOutbox.attempts} + 1`, nextAttemptAt: now })
      .where(
        inArray(
          notificationOutbox.id,
          due.map((d) => d.id),
        ),
      );
    return due.map((d) => ({ ...d, attempts: d.attempts + 1 }));
  });

  let sent = 0;
  let failed = 0;
  for (const message of claimed) {
    try {
      if (!isTemplate(message.template))
        throw new DeliveryError(`Unknown template ${message.template}`, true);
      const render = TEMPLATES[message.template] as (payload: unknown) => {
        subject: string;
        html: string;
        text: string;
      };
      const rendered = render(message.payload);
      const result =
        message.channel === "email"
          ? await providers.email.sendEmail({ to: message.recipient, ...rendered })
          : await providers.sms.sendSms({ to: message.recipient, text: rendered.text });
      await database
        .update(notificationOutbox)
        .set({
          status: "sent",
          sentAt: new Date(),
          providerMessageId: result.messageId,
          payload: {},
          lastError: null,
        })
        .where(eq(notificationOutbox.id, message.id));
      sent++;
    } catch (error) {
      const permanent = error instanceof DeliveryError && error.permanent;
      const giveUp = permanent || message.attempts >= MAX_ATTEMPTS;
      const reason = error instanceof DeliveryError ? error.message : "Delivery failed";
      await database
        .update(notificationOutbox)
        .set({
          status: giveUp ? "failed" : "pending",
          nextAttemptAt: new Date(now.getTime() + backoffMs(message.attempts)),
          lastError: reason.slice(0, 300),
          // A failed message keeps no secrets around.
          ...(giveUp ? { payload: {} } : {}),
        })
        .where(eq(notificationOutbox.id, message.id));
      failed++;
    }
  }
  return { sent, failed };
}

/** Returns messages stuck in "sending" (e.g. the process crashed mid-send) to the queue. */
export async function releaseStuck(
  database: Database,
  olderThanMs = 10 * 60_000,
  now = new Date(),
): Promise<number> {
  const result = await database
    .update(notificationOutbox)
    .set({ status: "pending" })
    .where(
      and(
        eq(notificationOutbox.status, "sending"),
        lt(notificationOutbox.nextAttemptAt, new Date(now.getTime() - olderThanMs)),
      ),
    );
  return result.rowCount ?? 0;
}
