import "server-only";
import { recordSmsUsage, smsAllowance } from "../billing/usage";
import type { Transaction } from "../db/client";
import type { smsUsage } from "../db/schema";
import { DomainError } from "../errors";
import { enqueue, smsSegmentsFor } from "../notifications/outbox";
import type { TEMPLATES } from "../notifications/templates";
import { pushSubscriptionsFor } from "../parents/push";

/**
 * Telling families about something new (a consent form, an event reminder): a free push to every phone of
 * theirs with notifications on (PSH-03), and, when chosen, one SMS to each family without, within the
 * school's SMS allowance. Queued in the caller's transaction, so nothing is sent unless it commits.
 */

type SmsTemplate = "consent_request" | "event_reminder";
type PushTemplate = "consent_push" | "event_push";

export interface FamilyNotice<S extends SmsTemplate, P extends PushTemplate> {
  school: { id: string; name: string; timezone: string; isDemo: boolean };
  phones: readonly string[];
  /** Send SMS to families without push. */
  sms: boolean;
  /** True while SMS are paused for an overdue EduBridge invoice. */
  smsPaused: boolean;
  smsTemplate: S;
  smsPayload: Parameters<(typeof TEMPLATES)[S]>[0];
  smsKind: (typeof smsUsage.$inferInsert)["kind"];
  pushTemplate: P;
  pushPayload: Parameters<(typeof TEMPLATES)[P]>[0];
  /** Unique to this notice: with each recipient it makes the outbox idempotency key. */
  key: string;
  /** "throw" when staff send it (they can choose again); "skip" for the worker (push still goes). */
  onLimit: "throw" | "skip";
}

export interface NoticeResult {
  sms: number;
  push: number;
  /** Why SMS were not sent although chosen. */
  smsSkipped: "paused" | "sms_limit" | null;
}

export async function notifyFamilies<S extends SmsTemplate, P extends PushTemplate>(
  tx: Transaction,
  notice: FamilyNotice<S, P>,
): Promise<NoticeResult> {
  // Demo schools never send (their numbers are made up).
  if (notice.school.isDemo || notice.phones.length === 0) return { sms: 0, push: 0, smsSkipped: null };
  const devices = await pushSubscriptionsFor(tx, notice.phones);
  const pushed = new Set(devices.map((d) => d.phone));
  let phones = notice.sms ? notice.phones.filter((p) => !pushed.has(p)) : [];
  let smsSkipped: NoticeResult["smsSkipped"] = null;
  if (phones.length && notice.smsPaused) {
    if (notice.onLimit === "throw")
      throw new DomainError(
        "sms_paused",
        "SMS to families are paused because an EduBridge invoice is overdue. Send it without SMS.",
      );
    phones = [];
    smsSkipped = "paused";
  }
  if (phones.length) {
    const left = await smsAllowance(tx, notice.school.id, notice.school.timezone);
    const need = phones.length * smsSegmentsFor(notice.smsTemplate, notice.smsPayload);
    if (left !== null && left < need) {
      if (notice.onLimit === "throw")
        throw new DomainError(
          "sms_limit",
          `This needs ${need} SMS, and your plan has ${left} left this month. Send it without SMS, or choose fewer families.`,
        );
      phones = [];
      smsSkipped = "sms_limit";
    }
  }
  for (const phone of phones) {
    const outboxId = await enqueue(tx, {
      channel: "sms",
      recipient: phone,
      template: notice.smsTemplate,
      payload: notice.smsPayload,
      idempotencyKey: `${notice.key}:${phone}`,
    });
    await recordSmsUsage(tx, notice.school.id, notice.smsKind, outboxId);
  }
  for (const device of devices)
    await enqueue(tx, {
      channel: "push",
      recipient: device.id,
      template: notice.pushTemplate,
      payload: notice.pushPayload,
      idempotencyKey: `${notice.key}:${device.id}`,
    });
  return { sms: phones.length, push: pushed.size, smsSkipped };
}
