import "server-only";
import { and, eq, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { notificationOutbox, whatsappContacts } from "../db/schema";
import { isStopReply, parseWhatsAppWebhook } from "./whatsapp";

/**
 * Meta's webhook (signature checked by the route before this runs): handset receipts for messages sent by
 * WhatsApp (NOT-07), the SMS fallback when WhatsApp reports a failure, and STOP replies, which opt the
 * number out at once. Replays are harmless: every change is a state the row can only move forward to.
 */
export async function handleWhatsAppWebhook(
  database: Database,
  body: unknown,
): Promise<{ statuses: number; fallbacks: number; optOuts: number }> {
  const { statuses, replies } = parseWhatsAppWebhook(body);
  let fallbacks = 0;
  for (const s of statuses) {
    const match = and(
      eq(notificationOutbox.providerMessageId, s.messageId),
      eq(notificationOutbox.sentVia, "whatsapp"),
    );
    if (s.status === "delivered" || s.status === "read") {
      await database
        .update(notificationOutbox)
        .set({
          deliveredAt: sql`coalesce(${notificationOutbox.deliveredAt}, ${s.at})`,
          ...(s.status === "read" ? { readAt: sql`coalesce(${notificationOutbox.readAt}, ${s.at})` } : {}),
          // Delivered: no SMS fallback is needed any more, so nothing private is kept.
          payload: {},
        })
        .where(match);
    } else if (s.status === "failed") {
      // Not delivered by WhatsApp: the same message goes by SMS (and is charged as an SMS), unless its
      // content is already gone (delivered earlier, or past the fallback window).
      const moved = await database
        .update(notificationOutbox)
        .set({
          status: "pending",
          sentVia: null,
          whatsappAllowed: false,
          providerMessageId: null,
          nextAttemptAt: new Date(),
          lastError: `WhatsApp could not deliver it${s.errorCode ? ` (code ${s.errorCode})` : ""}; sent by SMS instead.`,
        })
        .where(and(match, isNotNull(notificationOutbox.payload), ne(notificationOutbox.payload, {})))
        .returning({ id: notificationOutbox.id });
      fallbacks += moved.length;
    }
  }
  let optOuts = 0;
  for (const r of replies.filter((reply) => isStopReply(reply.text))) {
    await database
      .insert(whatsappContacts)
      .values({ phone: r.from, optedOutAt: new Date(), source: "whatsapp_reply" })
      .onConflictDoUpdate({
        target: whatsappContacts.phone,
        set: { optedOutAt: new Date(), source: "whatsapp_reply", updatedAt: new Date() },
      });
    optOuts++;
  }
  return { statuses: statuses.length, fallbacks, optOuts };
}

/** WhatsApp content kept for the SMS fallback is cleared after two days (hourly, by the worker). */
export async function purgeWhatsAppPayloads(database: Database, now = new Date()): Promise<number> {
  const rows = await database
    .update(notificationOutbox)
    .set({ payload: {} })
    .where(
      and(
        eq(notificationOutbox.sentVia, "whatsapp"),
        lt(notificationOutbox.sentAt, new Date(now.getTime() - 2 * 86_400_000)),
        ne(notificationOutbox.payload, {}),
      ),
    )
    .returning({ id: notificationOutbox.id });
  return rows.length;
}
