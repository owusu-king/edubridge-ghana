import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { whatsappCloudProvider, whatsappConfigured, type WhatsAppProvider } from "./whatsapp";

/**
 * Delivery providers. Brevo (email), Arkesel (SMS) and web push (VAPID keys) are used when configured.
 * Outside production, missing keys fall back to a log provider that writes messages to a local
 * development mailbox instead of sending them. In production, missing keys are an error.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SmsMessage {
  to: string;
  text: string;
}

export interface SendResult {
  messageId: string;
}

export interface EmailProvider {
  name: string;
  sendEmail(message: EmailMessage): Promise<SendResult>;
}

export interface SmsProvider {
  name: string;
  sendSms(message: SmsMessage): Promise<SendResult>;
}

/** A web push to one browser subscription. The payload is JSON the service worker shows (no secrets). */
export interface PushMessage {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  payload: { title: string; body: string; url: string };
}

export interface PushProvider {
  name: string;
  sendPush(message: PushMessage): Promise<SendResult>;
}

/** A failure with a message safe to store (no secrets, no message content). */
export class DeliveryError extends Error {
  constructor(
    message: string,
    /** Permanent failures (e.g. invalid recipient) are not retried. */
    readonly permanent = false,
    /** For push: the subscription no longer exists at the push service and should be removed. */
    readonly gone = false,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

const TIMEOUT_MS = 10_000;

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json: unknown = await response.json().catch(() => null);
  return { status: response.status, json };
}

export function brevoProvider(config: {
  apiKey: string;
  fromEmail: string;
  fromName: string;
  sandbox: boolean;
}): EmailProvider {
  return {
    name: "brevo",
    async sendEmail(message) {
      const { status, json } = await postJson(
        "https://api.brevo.com/v3/smtp/email",
        { "api-key": config.apiKey },
        {
          sender: { email: config.fromEmail, name: config.fromName },
          to: [{ email: message.to }],
          subject: message.subject,
          htmlContent: message.html,
          textContent: message.text,
          // Brevo's sandbox: validates the request without sending.
          ...(config.sandbox ? { headers: { "X-Sib-Sandbox": "drop" } } : {}),
        },
      );
      const messageId = (json as { messageId?: unknown } | null)?.messageId;
      if (status >= 200 && status < 300 && typeof messageId === "string") return { messageId };
      const code = (json as { code?: unknown } | null)?.code;
      throw new DeliveryError(
        `Brevo responded ${status}${typeof code === "string" ? ` (${code})` : ""}`,
        status === 400,
      );
    },
  };
}

export function arkeselProvider(config: { apiKey: string; senderId: string; sandbox: boolean }): SmsProvider {
  return {
    name: "arkesel",
    async sendSms(message) {
      const { status, json } = await postJson(
        "https://sms.arkesel.com/api/v2/sms/send",
        { "api-key": config.apiKey },
        {
          sender: config.senderId,
          message: message.text,
          // Arkesel expects international format without "+".
          recipients: [message.to.replace(/^\+/, "")],
          ...(config.sandbox ? { sandbox: true } : {}),
        },
      );
      const body = json as { status?: unknown; data?: { id?: unknown }[] } | null;
      if (status >= 200 && status < 300 && body?.status === "success") {
        const id = body.data?.[0]?.id;
        return { messageId: typeof id === "string" ? id : `arkesel-${randomUUID()}` };
      }
      throw new DeliveryError(
        `Arkesel responded ${status}${typeof body?.status === "string" ? ` (${body.status})` : ""}`,
        status === 422,
      );
    },
  };
}

/**
 * Web push with VAPID (RFC 8030, 8291, 8292) through the web-push package. Messages live for a day at the
 * push service; a 404 or 410 means the browser dropped the subscription.
 */
export function webPushProvider(config: {
  publicKey: string;
  privateKey: string;
  subject: string;
}): PushProvider {
  return {
    name: "web-push",
    async sendPush(message) {
      const { sendNotification } = await import("web-push");
      try {
        const result = await sendNotification(message.subscription, JSON.stringify(message.payload), {
          vapidDetails: config,
          TTL: 86_400,
          urgency: "normal",
          timeout: TIMEOUT_MS,
        });
        return { messageId: result.headers?.location ?? `push-${randomUUID()}` };
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410)
          throw new DeliveryError("Notifications were turned off on that device.", true, true);
        if (status === 400 || status === 403 || status === 413)
          throw new DeliveryError(`The push service refused the message (${status}).`, true);
        throw new DeliveryError(status ? `Push service error (${status}).` : "Push service unreachable.");
      }
    },
  };
}

/** Development only: appends messages to a local JSON-lines mailbox (read by end-to-end tests). */
export function logProvider(file: string): EmailProvider & SmsProvider & PushProvider & WhatsAppProvider {
  const write = (entry: Record<string, unknown>) => {
    const id = `dev-${randomUUID()}`;
    appendFileSync(file, `${JSON.stringify({ id, at: new Date().toISOString(), ...entry })}\n`);
    return { messageId: id };
  };
  return {
    name: "log",
    async sendEmail(message) {
      return write({ channel: "email", to: message.to, subject: message.subject, text: message.text });
    },
    async sendSms(message) {
      return write({ channel: "sms", to: message.to, text: message.text });
    },
    async sendTemplate(message) {
      return write({ channel: "whatsapp", to: message.to, template: message.template, text: message.text });
    },
    async sendPush(message) {
      return write({
        channel: "push",
        to: new URL(message.subscription.endpoint).host,
        text: `${message.payload.title}: ${message.payload.body}`,
        url: message.payload.url,
      });
    },
  };
}

export interface Providers {
  email: EmailProvider;
  sms: SmsProvider;
  push: PushProvider;
  /** Absent or null: WhatsApp is not set up, and SMS go as SMS. */
  whatsapp?: WhatsAppProvider | null;
}

/** The VAPID public key browsers subscribe with, or null when web push is not configured. */
export function vapidPublicKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.VAPID_PUBLIC_KEY?.trim() || null;
}

export function providersFromEnv(env: NodeJS.ProcessEnv = process.env): Providers {
  // NOTIFICATIONS_TRANSPORT=log is an explicit opt-in for test environments (e.g. end-to-end runs).
  const forceLog = env.NOTIFICATIONS_TRANSPORT === "log";
  const production = env.NODE_ENV === "production" && !forceLog;
  const devMailbox = logProvider(env.DEV_MAILBOX_FILE ?? ".dev-mailbox.jsonl");
  const missing = (what: string) => {
    throw new DeliveryError(`${what} is not configured.`);
  };

  const email: EmailProvider = forceLog
    ? devMailbox
    : env.BREVO_API_KEY
      ? brevoProvider({
          apiKey: env.BREVO_API_KEY,
          fromEmail: env.EMAIL_FROM ?? missing("EMAIL_FROM"),
          fromName: env.EMAIL_FROM_NAME ?? "EduBridge",
          sandbox: env.BREVO_SANDBOX === "true",
        })
      : production
        ? { name: "unconfigured", sendEmail: async () => missing("BREVO_API_KEY") }
        : devMailbox;

  const sms: SmsProvider = forceLog
    ? devMailbox
    : env.ARKESEL_API_KEY
      ? arkeselProvider({
          apiKey: env.ARKESEL_API_KEY,
          senderId: env.SMS_SENDER_ID ?? "EduBridge",
          sandbox: env.ARKESEL_SANDBOX === "true",
        })
      : production
        ? { name: "unconfigured", sendSms: async () => missing("ARKESEL_API_KEY") }
        : devMailbox;

  // A misconfigured push setting must never stop email or SMS: it fails only when a push is sent.
  const publicKey = vapidPublicKey(env);
  const subject = env.VAPID_SUBJECT?.trim() || env.APP_URL?.trim();
  const push: PushProvider = forceLog
    ? devMailbox
    : publicKey && env.VAPID_PRIVATE_KEY && subject
      ? webPushProvider({ publicKey, privateKey: env.VAPID_PRIVATE_KEY.trim(), subject })
      : production || publicKey
        ? { name: "unconfigured", sendPush: async () => missing("VAPID_PRIVATE_KEY and VAPID_SUBJECT") }
        : devMailbox;

  // WhatsApp only when its keys are set (log mailbox outside production); never needed for SMS to work.
  const whatsapp: WhatsAppProvider | null = forceLog
    ? devMailbox
    : whatsappConfigured(env)
      ? whatsappCloudProvider({
          accessToken: env.WHATSAPP_ACCESS_TOKEN!.trim(),
          phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID!.trim(),
          version: env.WHATSAPP_GRAPH_VERSION?.trim() || "v24.0",
        })
      : production
        ? null
        : devMailbox;

  return { email, sms, push, whatsapp };
}

/** Whether families can be offered WhatsApp on this deployment (keys set, or the development mailbox). */
export function whatsappAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NOTIFICATIONS_TRANSPORT === "log" || whatsappConfigured(env) || env.NODE_ENV !== "production";
}
