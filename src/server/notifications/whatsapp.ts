import { createHmac, timingSafeEqual } from "node:crypto";
import { formatMoney } from "@/lib/money";
import type { TemplateName } from "./templates";

/**
 * WhatsApp Business (WAB-01) through Meta's WhatsApp Cloud API, from EduBridge's own WhatsApp number, with
 * each school's name in the message. Business-initiated messages must use templates approved by Meta; these
 * are utility templates (about the family's own child and account), registered in English under the names
 * below with exactly these bodies (docs: deployment guide). Sign-in and application codes stay SMS.
 *
 * Meta's rules followed here: a template body neither starts nor ends with a variable, variables carry
 * no newlines, and every message goes only to a number that opted in (whatsapp_contacts).
 */

export interface WhatsAppTemplate {
  /** The template's name as approved in WhatsApp Manager. */
  name: string;
  /** The approved body, for the deployment guide and the development mailbox. */
  body: string;
  params: (payload: Record<string, unknown>, appUrl: (path: string) => string) => string[];
}

const str = (v: unknown, fallback = "") => (typeof v === "string" && v ? v : fallback).replace(/\s+/g, " ");
const money = (p: Record<string, unknown>, key: string) =>
  formatMoney(Number(p[key] ?? 0), typeof p.currency === "string" ? p.currency : "GHS");

function balanceSentence(p: Record<string, unknown>): string {
  const balance = Number(p.balancePesewas ?? 0);
  if (balance > 0) return `The balance is now ${money(p, "balancePesewas")}.`;
  if (balance < 0)
    return `There is ${formatMoney(-balance, typeof p.currency === "string" ? p.currency : "GHS")} in credit.`;
  return "Fees are fully paid.";
}

export const WHATSAPP_TEMPLATES: Partial<Record<TemplateName, WhatsAppTemplate>> = {
  payment_receipt: {
    name: "edubridge_payment_receipt",
    body: "Payment received by {{1}}: {{2}} for {{3}}, receipt {{4}}. {{5}} The receipt is in the EduBridge parent view.",
    params: (p) => [
      str(p.schoolName),
      money(p, "amountPesewas"),
      str(p.studentFirstName, "your child"),
      str(p.receiptNumber),
      balanceSentence(p),
    ],
  },
  fees_billed: {
    name: "edubridge_fees_billed",
    body: "Fees notice from {{1}}: fees for {{2}} have been billed for {{3}}. {{4}} See the details in the EduBridge parent view.",
    params: (p) => [
      str(p.schoolName),
      str(p.termLabel, "this term"),
      str(p.studentFirstName, "your child"),
      balanceSentence(p),
    ],
  },
  fee_reminder: {
    name: "edubridge_fee_reminder",
    body: "A reminder from {{1}} about fees for {{2}}: {{3}} See the balance and pay at {{4}} Thank you.",
    params: (p, appUrl) => [
      str(p.schoolName),
      str(p.studentFirstName, "your child"),
      p.balancePesewas !== undefined ? `${money(p, "balancePesewas")} is owed.` : "a balance is owed.",
      typeof p.balanceLinkToken === "string" ? appUrl(`/b/${p.balanceLinkToken}`) : appUrl("/p"),
    ],
  },
  absence_alert: {
    name: "edubridge_absence_alert",
    body: "Attendance notice from {{1}}: {{2}} has been absent for {{3}}. Please contact the school.",
    params: (p) => {
      const days = Number(p.days ?? 1);
      const span = `${days} ${days === 1 ? "school day" : "school days"}${p.kind === "term_total" ? " this term" : " in a row"}`;
      return [str(p.schoolName), str(p.studentFirstName, "Your child"), span];
    },
  },
  announcement: {
    name: "edubridge_announcement",
    body: "New announcement from {{1}}: {{2}}. Read it in the EduBridge parent view at {{3}} using this number.",
    params: (p, appUrl) => [str(p.schoolName), str(p.title).slice(0, 100), appUrl("/p")],
  },
  portal_invitation: {
    name: "edubridge_portal_invitation",
    body: "Invitation from {{1}}: follow {{2}}'s fees, reports and news in the EduBridge parent view at {{3}} using this number.",
    params: (p, appUrl) => [str(p.schoolName), str(p.studentFirstName, "your child"), appUrl("/p")],
  },
  consent_request: {
    name: "edubridge_consent_request",
    body: 'Consent form from {{1}}: please answer "{{2}}" by {{3}} in the EduBridge parent view at {{4}} using this number.',
    params: (p, appUrl) => [str(p.schoolName), str(p.title).slice(0, 100), str(p.deadline), appUrl("/p")],
  },
  event_reminder: {
    name: "edubridge_event_reminder",
    body: "Reminder from {{1}}: {{2}}, {{3}}. Details are in the EduBridge parent view.",
    params: (p) => [
      str(p.schoolName),
      str(p.title).slice(0, 100),
      [str(p.when), str(p.location)].filter(Boolean).join(", "),
    ],
  },
};

/** The family-message kinds (sms_usage.kind) that may go by WhatsApp: those with a template above. */
export const WHATSAPP_KINDS = [
  "payment_receipt",
  "fees_billed",
  "fee_reminder",
  "absence_alert",
  "announcement",
  "portal_invitation",
  "consent_request",
  "event_reminder",
] as const;

/** The body with its values filled in (development mailbox, and the text shown in delivery reports). */
export function fillTemplate(body: string, params: readonly string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1] ?? "");
}

// ——— Provider ———

export interface WhatsAppMessage {
  /** E.164, e.g. +233241234567. */
  to: string;
  template: string;
  language: string;
  params: string[];
  /** The filled-in text (for the development mailbox). */
  text: string;
}

export interface WhatsAppProvider {
  name: string;
  sendTemplate(message: WhatsAppMessage): Promise<{ messageId: string }>;
}

export class WhatsAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppError";
  }
}

/** Meta's WhatsApp Cloud API: POST /{version}/{phone-number-id}/messages with a template. */
export function whatsappCloudProvider(config: {
  accessToken: string;
  phoneNumberId: string;
  version: string;
  baseUrl?: string;
}): WhatsAppProvider {
  const base = (config.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "");
  return {
    name: "whatsapp-cloud",
    async sendTemplate(message) {
      let response: Response;
      try {
        response = await fetch(
          `${base}/${config.version}/${encodeURIComponent(config.phoneNumberId)}/messages`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.accessToken}`,
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to: message.to.replace(/^\+/, ""),
              type: "template",
              template: {
                name: message.template,
                language: { code: message.language },
                components: [
                  { type: "body", parameters: message.params.map((text) => ({ type: "text", text })) },
                ],
              },
            }),
            signal: AbortSignal.timeout(10_000),
          },
        );
      } catch {
        throw new WhatsAppError("WhatsApp unreachable.");
      }
      const json = (await response.json().catch(() => null)) as {
        messages?: { id?: string }[];
        error?: { code?: number; message?: string };
      } | null;
      const id = json?.messages?.[0]?.id;
      if (!response.ok || !id)
        // Meta's code only (no message content, no token) is safe to store.
        throw new WhatsAppError(
          `WhatsApp refused the message (${response.status}${json?.error?.code ? `, code ${json.error.code}` : ""}).`,
        );
      return { messageId: id };
    },
  };
}

/** Configured when the Cloud API token and phone number id are set. */
export function whatsappConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.WHATSAPP_ACCESS_TOKEN?.trim() && env.WHATSAPP_PHONE_NUMBER_ID?.trim());
}

export const whatsappLanguage = (env: NodeJS.ProcessEnv = process.env) =>
  env.WHATSAPP_TEMPLATE_LANGUAGE?.trim() || "en";

// ——— Webhook (Meta signs every POST with the app secret) ———

/** X-Hub-Signature-256: "sha256=" + HMAC-SHA256 of the raw body with the app secret. */
export function verifyWhatsAppSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=") || !appSecret) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const given = header.slice("sha256=".length);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

export interface WhatsAppStatus {
  messageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  at: Date;
  /** Meta's error code on failure (stored; no message content). */
  errorCode: number | null;
}

export interface WhatsAppReply {
  /** E.164. */
  from: string;
  text: string;
}

/** The statuses and text replies in a webhook body; anything else is ignored. */
export function parseWhatsAppWebhook(body: unknown): {
  statuses: WhatsAppStatus[];
  replies: WhatsAppReply[];
} {
  const statuses: WhatsAppStatus[] = [];
  const replies: WhatsAppReply[] = [];
  const entries = (body as { entry?: unknown[] } | null)?.entry;
  if (!Array.isArray(entries)) return { statuses, replies };
  for (const entry of entries) {
    for (const change of (entry as { changes?: unknown[] }).changes ?? []) {
      const value = (change as { value?: Record<string, unknown> }).value ?? {};
      for (const s of (value.statuses as Record<string, unknown>[] | undefined) ?? []) {
        const status = s.status;
        if (typeof s.id !== "string" || !["sent", "delivered", "read", "failed"].includes(String(status)))
          continue;
        const errors = s.errors as { code?: number }[] | undefined;
        statuses.push({
          messageId: s.id,
          status: status as WhatsAppStatus["status"],
          at: new Date(Number(s.timestamp ?? 0) * 1000 || Date.now()),
          errorCode: typeof errors?.[0]?.code === "number" ? errors[0].code : null,
        });
      }
      for (const m of (value.messages as Record<string, unknown>[] | undefined) ?? []) {
        const text = (m.text as { body?: string } | undefined)?.body;
        if (typeof m.from === "string" && /^\d{8,15}$/.test(m.from) && typeof text === "string")
          replies.push({ from: `+${m.from}`, text });
      }
    }
  }
  return { statuses, replies };
}

/** A reply that opts the number out (the usual keywords; case and spaces ignored). */
export const isStopReply = (text: string) =>
  ["stop", "unsubscribe", "stop all", "cancel", "end", "quit"].includes(text.trim().toLowerCase());
