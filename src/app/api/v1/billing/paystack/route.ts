import { db } from "@/server/db/client";
import {
  confirmInvoicePayment,
  invoicePaymentsFromEnv,
  invoiceReferenceFromWebhook,
} from "@/server/billing/online-payments";
import { apiError } from "@/web/api";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Paystack webhook for EduBridge's own account (SUB-04): set this URL on that account, not on the account
 * schools' Mobile Money uses. The signature is checked with EduBridge's key; the outcome is then read from
 * Paystack's verify endpoint, never from this body.
 */
export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return apiError(413, "too_large", "Webhook too large.");
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return apiError(413, "too_large", "Webhook too large.");
  const provider = invoicePaymentsFromEnv();
  if (!provider || provider.name !== "paystack") return apiError(404, "not_found", "Not found.");
  if (!provider.verifyWebhook(rawBody, request.headers.get("x-paystack-signature")))
    return apiError(401, "invalid_signature", "The webhook signature is not valid.");
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return apiError(400, "invalid_body", "Not JSON.");
  }
  const reference = invoiceReferenceFromWebhook(body);
  if (reference) await confirmInvoicePayment(db(), reference, { provider });
  return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
}
