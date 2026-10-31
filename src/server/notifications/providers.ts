import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/**
 * Delivery providers. Brevo (email) and Arkesel (SMS) are used when their API keys are configured.
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

/** A failure with a message safe to store (no secrets, no message content). */
export class DeliveryError extends Error {
  constructor(
    message: string,
    /** Permanent failures (e.g. invalid recipient) are not retried. */
    readonly permanent = false,
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

/** Development only: appends messages to a local JSON-lines mailbox (read by end-to-end tests). */
export function logProvider(file: string): EmailProvider & SmsProvider {
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
  };
}

export interface Providers {
  email: EmailProvider;
  sms: SmsProvider;
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

  return { email, sms };
}
