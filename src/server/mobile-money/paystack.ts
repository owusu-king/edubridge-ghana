import { createHmac, timingSafeEqual } from "node:crypto";
import type { MobileMoneyNetwork } from "@/lib/mobile-money";
import {
  ProviderError,
  type CallbackRef,
  type CollectionRef,
  type CollectionRequest,
  type CollectionStarted,
  type CollectionStatus,
  type IncomingCallback,
  type MobileMoneyProvider,
} from "./provider";

/**
 * Paystack (D-06, chosen 2026-11-06): Mobile Money through Paystack's Charge API.
 *
 * - A payment's Paystack reference is `{school id}.{request id}`, so a webhook, which Paystack sends to one
 *   address for the whole integration, says which school and request it is about.
 * - Each school's money settles to its own Paystack subaccount (D-07); live payments are refused without one.
 * - Webhooks are checked with Paystack's HMAC-SHA512 signature; the outcome is always read from
 *   `transaction/verify`, never from the webhook, and the amount and currency are checked by the caller.
 * - Paystack needs an email for every payer. Families are reached by phone, so the payer's email is made
 *   from their number at a domain EduBridge controls (PAYSTACK_CUSTOMER_EMAIL_DOMAIN).
 *
 * Behaviour observed in Paystack's test mode (2026-11-06): the MTN test number 055 123 4987 approves at
 * once; every other number is declined with a message saying so; an unknown reference answers HTTP 400
 * with code transaction_not_found. Live prompts (status pay_offline, then a webhook) are not verified yet.
 */

export const PAYSTACK_TEST_NUMBER = "0551234987";

const NETWORK_CODES: Record<MobileMoneyNetwork, string> = { mtn: "mtn", telecel: "vod", at: "atl" };

/** Charge statuses meaning the payer has been asked (or it already went through): wait for the outcome. */
const STARTED = new Set(["success", "pay_offline", "pending", "ongoing", "processing", "queued"]);
/** Statuses asking EduBridge for more from the payer (a code, a PIN...): not supported yet. */
const NEEDS_INPUT = new Set([
  "send_otp",
  "send_pin",
  "send_phone",
  "send_birthday",
  "send_address",
  "open_url",
]);

export interface PaystackConfig {
  secretKey: string;
  /** Payers' emails are made at this domain (Paystack requires one per customer). */
  customerEmailDomain: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Abandons a call to Paystack after this long (the request then stays pending and is checked later). */
  timeoutMs?: number;
}

/** Our reference for Paystack: the school, then the request. */
export const paystackReference = (tenantId: string, requestId: string) => `${tenantId}.${requestId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Reads a reference made by paystackReference; null for anything else. */
export function parsePaystackReference(reference: string): { tenantId: string; requestId: string } | null {
  const [tenantId, requestId, ...rest] = reference.split(".");
  if (rest.length || !tenantId || !requestId || !UUID.test(tenantId) || !UUID.test(requestId)) return null;
  return { tenantId, requestId };
}

/** Paystack's messages can be long or technical: keep them short and plain. */
const safe = (text: unknown, fallback: string) =>
  typeof text === "string" && text.trim() ? text.trim().slice(0, 200) : fallback;

interface PaystackResponse {
  status?: boolean;
  message?: string;
  code?: string;
  data?: Record<string, unknown> | null;
}

export function paystackProvider(config: PaystackConfig): MobileMoneyProvider {
  const baseUrl = config.baseUrl ?? "https://api.paystack.co";
  const doFetch = config.fetch ?? fetch;
  const testMode = config.secretKey.startsWith("sk_test_");

  async function call(
    path: string,
    init: RequestInit = {},
  ): Promise<{ http: number; body: PaystackResponse }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 20_000);
    try {
      const response = await doFetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.secretKey}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      const body = (await response.json().catch(() => ({}))) as PaystackResponse;
      return { http: response.status, body };
    } catch {
      // Network failure or timeout: we cannot know whether Paystack received the request.
      throw new ProviderError("Paystack did not answer in time. The payment is checked again shortly.");
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: "paystack",
    testMode,
    testHint: testMode
      ? "Paystack test mode: no money moves. Use the MTN test number 055 123 4987, which approves at once; Paystack declines every other number in test mode."
      : undefined,

    async requestPayment(request: CollectionRequest): Promise<CollectionStarted> {
      if (!testMode && !request.settlementAccount)
        throw new ProviderError(
          "This school's Paystack account is not set up yet, so Mobile Money cannot be used. Ask EduBridge.",
          true,
        );
      const digits = request.msisdn.replace(/\D/g, "");
      const local = digits.startsWith("233") ? `0${digits.slice(3)}` : digits;
      const { http, body } = await call("/charge", {
        method: "POST",
        body: JSON.stringify({
          email: `payer.${digits}@${config.customerEmailDomain}`,
          amount: request.amountPesewas,
          currency: request.currency,
          reference: paystackReference(request.tenantId, request.reference),
          mobile_money: { phone: local, provider: NETWORK_CODES[request.network] },
          ...(request.settlementAccount ? { subaccount: request.settlementAccount } : {}),
          metadata: { edubridge_request: request.reference, description: request.payerMessage.slice(0, 120) },
        }),
      });
      if (http >= 500)
        throw new ProviderError("Paystack is not available. The payment is checked again shortly.");
      const status = typeof body.data?.status === "string" ? body.data.status : null;
      const reference = typeof body.data?.reference === "string" ? body.data.reference : null;
      if (http >= 400 || !body.status)
        throw new ProviderError(safe(body.message, "Paystack refused this payment."), true);
      if (status && STARTED.has(status)) return { providerReference: reference };
      if (status && NEEDS_INPUT.has(status))
        throw new ProviderError(
          "This network asks the payer for a one-time code, which EduBridge cannot take yet. Try another network, or record the payment by hand.",
          true,
        );
      if (status === "failed")
        throw new ProviderError(
          safe(body.data?.message ?? body.data?.gateway_response, "The payment was declined."),
          true,
        );
      // An answer we do not know: treat as sent, and let the status check settle it.
      return { providerReference: reference };
    },

    async getStatus(ref: CollectionRef): Promise<CollectionStatus> {
      const reference = ref.providerReference ?? paystackReference(ref.tenantId, ref.reference);
      const { http, body } = await call(`/transaction/verify/${encodeURIComponent(reference)}`);
      if (http === 400 && body.code === "transaction_not_found") return { state: "not_found" };
      if (http === 404) return { state: "not_found" };
      if (http >= 400 || !body.status || !body.data)
        throw new ProviderError(safe(body.message, "Paystack could not report on this payment."));
      const data = body.data;
      const status = String(data.status ?? "");
      if (status === "success") {
        const amount = Number(data.amount);
        if (!Number.isSafeInteger(amount))
          throw new ProviderError("Paystack reported an amount EduBridge cannot read.");
        return {
          state: "successful",
          amountPesewas: amount,
          currency: String(data.currency ?? ""),
          transactionId: `PSK-${String(data.id ?? reference)}`.slice(0, 60),
          completedAt: typeof data.paid_at === "string" ? new Date(data.paid_at) : null,
        };
      }
      if (status === "failed" || status === "abandoned" || status === "reversed")
        return {
          state: "failed",
          reason: safe(data.gateway_response ?? data.message, `Paystack: ${status}`),
        };
      return { state: "pending" };
    },

    verifyCallback(callback: IncomingCallback): CallbackRef | null {
      const signature = callback.headers.get("x-paystack-signature") ?? "";
      const expected = createHmac("sha512", config.secretKey).update(callback.rawBody).digest("hex");
      const a = Buffer.from(signature, "utf8");
      const b = Buffer.from(expected, "utf8");
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      let event: { data?: { reference?: unknown } };
      try {
        event = JSON.parse(callback.rawBody) as typeof event;
      } catch {
        return null;
      }
      const providerReference = typeof event.data?.reference === "string" ? event.data.reference : null;
      const ours = providerReference ? parsePaystackReference(providerReference) : null;
      return { reference: ours?.requestId ?? null, providerReference, tenantId: ours?.tenantId ?? null };
    },
  };
}
