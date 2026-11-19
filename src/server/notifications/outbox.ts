import "server-only";
import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { Database, Queryable } from "../db/client";
import { notificationOutbox, pushSubscriptions, whatsappContacts } from "../db/schema";
import { DeliveryError, providersFromEnv, type Providers } from "./providers";
import { smsSegments } from "../../lib/sms";
import { appUrl, isTemplate, TEMPLATES, type TemplateName } from "./templates";
import { fillTemplate, WHATSAPP_TEMPLATES, whatsappLanguage, WhatsAppError } from "./whatsapp";

export const MAX_ATTEMPTS = 5;

export interface EnqueueInput<T extends TemplateName> {
  /** For push, the recipient is a push subscription id. */
  channel: "email" | "sms" | "push";
  recipient: string;
  template: T;
  payload: Parameters<(typeof TEMPLATES)[T]>[0];
  /**
   * For senders that may run twice for the same event: a message with the same key to the same recipient
   * on the same channel is queued once (the first one's id is returned).
   */
  idempotencyKey?: string;
}

/** The SMS segments a template's text takes with this payload (what the school is charged). */
export function smsSegmentsFor<T extends TemplateName>(
  template: T,
  payload: Parameters<(typeof TEMPLATES)[T]>[0],
): number {
  const render = TEMPLATES[template] as (payload: unknown) => { text: string };
  return Math.min(20, smsSegments(render(payload).text));
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
      segments: input.channel === "sms" ? smsSegmentsFor(input.template, input.payload) : 1,
      idempotencyKey: input.idempotencyKey ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: notificationOutbox.id });
  if (row) return row.id;
  // Already queued for this event: return that message.
  const [existing] = await db
    .select({ id: notificationOutbox.id })
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.channel, input.channel),
        eq(notificationOutbox.recipient, input.recipient),
        eq(notificationOutbox.idempotencyKey, input.idempotencyKey ?? ""),
      ),
    );
  if (!existing) throw new Error("The message could not be queued.");
  return existing.id;
}

/** Exponential backoff: 1, 2, 4, 8 minutes. */
const backoffMs = (attempts: number) => 60_000 * 2 ** Math.max(0, attempts - 1);

/**
 * Claims due messages (SKIP LOCKED, so several dispatchers never send the same message), sends them,
 * and records the outcome. Payloads are cleared after sending; failures keep only a safe error message.
 */
export async function dispatchPending(
  database: Database,
  opts: {
    limit?: number;
    providers?: Providers;
    now?: Date;
    /** Only these messages. For tests, which share one outbox and must not touch each other's messages. */
    ids?: readonly string[];
  } = {},
): Promise<{ sent: number; failed: number }> {
  const now = opts.now ?? new Date();
  const providers = opts.providers ?? providersFromEnv();
  const claimed = await database.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.status, "pending"),
          lte(notificationOutbox.nextAttemptAt, now),
          opts.ids ? inArray(notificationOutbox.id, [...opts.ids]) : undefined,
        ),
      )
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
        url?: string;
      };
      const rendered = render(message.payload);
      if (message.channel === "sms" && message.whatsappAllowed) {
        // WAB-01: by WhatsApp to a number that opted in; the payload is kept until WhatsApp confirms
        // delivery, so a failure reported later can still go by SMS.
        const via = await sendWhatsApp(database, providers, message);
        if (via) {
          await database
            .update(notificationOutbox)
            .set({
              status: "sent",
              sentAt: new Date(),
              sentVia: "whatsapp",
              providerMessageId: via.messageId,
              lastError: null,
            })
            .where(eq(notificationOutbox.id, message.id));
          sent++;
          continue;
        }
      }
      const result =
        message.channel === "email"
          ? await providers.email.sendEmail({ to: message.recipient, ...rendered })
          : message.channel === "push"
            ? await sendPush(database, providers, message.recipient, rendered)
            : await providers.sms.sendSms({ to: message.recipient, text: rendered.text });
      await database
        .update(notificationOutbox)
        .set({
          status: "sent",
          sentAt: new Date(),
          sentVia: message.channel === "sms" ? "sms" : null,
          providerMessageId: result.messageId,
          payload: {},
          lastError: null,
        })
        .where(eq(notificationOutbox.id, message.id));
      sent++;
    } catch (error) {
      const permanent = error instanceof DeliveryError && error.permanent;
      // The browser dropped the subscription: stop sending to it.
      if (message.channel === "push" && error instanceof DeliveryError && error.gone)
        await database.delete(pushSubscriptions).where(eq(pushSubscriptions.id, message.recipient));
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

/** Whether a number has chosen WhatsApp (and not opted out since). */
export async function whatsappOptedIn(db: Queryable, phone: string): Promise<boolean> {
  const [row] = await db.select().from(whatsappContacts).where(eq(whatsappContacts.phone, phone));
  return Boolean(row?.optedInAt && (!row.optedOutAt || row.optedInAt > row.optedOutAt));
}

/**
 * Tries WhatsApp for an SMS the school's plan lets go by WhatsApp. Null when it should go by SMS: WhatsApp
 * not set up, no template, the number has not opted in, or WhatsApp refused it (then SMS goes at once).
 */
async function sendWhatsApp(
  database: Database,
  providers: Providers,
  message: typeof notificationOutbox.$inferSelect,
): Promise<{ messageId: string } | null> {
  const template = isTemplate(message.template) ? WHATSAPP_TEMPLATES[message.template] : undefined;
  if (!providers.whatsapp || !template || !(await whatsappOptedIn(database, message.recipient))) return null;
  const params = template.params(message.payload, appUrl);
  try {
    return await providers.whatsapp.sendTemplate({
      to: message.recipient,
      template: template.name,
      language: whatsappLanguage(),
      params,
      text: fillTemplate(template.body, params),
    });
  } catch (error) {
    if (!(error instanceof WhatsAppError)) throw error;
    return null;
  }
}

/** Sends one push to a subscription (the recipient id), if the phone has not turned notifications off. */
async function sendPush(
  database: Database,
  providers: Providers,
  subscriptionId: string,
  rendered: { subject: string; text: string; url?: string },
) {
  const [subscription] = await database
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.id, subscriptionId));
  if (!subscription) throw new DeliveryError("Notifications were turned off on that device.", true);
  const result = await providers.push.sendPush({
    subscription: {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    },
    payload: { title: rendered.subject, body: rendered.text, url: rendered.url ?? "/p" },
  });
  await database
    .update(pushSubscriptions)
    .set({ lastSentAt: new Date() })
    .where(eq(pushSubscriptions.id, subscriptionId));
  return result;
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
