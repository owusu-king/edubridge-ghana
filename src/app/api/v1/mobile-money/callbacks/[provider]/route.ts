import { after } from "next/server";
import { db } from "@/server/db/client";
import { processMobileMoneyCallbacks, receiveMobileMoneyCallback } from "@/server/mobile-money/callbacks";
import { apiError } from "@/web/api";

export const dynamic = "force-dynamic";

/** Webhooks are small; anything larger is not from a provider. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Webhooks from providers that use one address for every school (Paystack: set this URL in the Paystack
 * dashboard). The signature is checked before anything is stored, and the school is read from the signed
 * payment reference. Events that are not about an EduBridge payment are acknowledged and dropped.
 */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return apiError(413, "too_large", "Callback too large.");
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return apiError(413, "too_large", "Callback too large.");

  const receipt = await receiveMobileMoneyCallback(db(), {
    providerName: provider,
    tenantId: null,
    headers: request.headers,
    rawBody,
  });
  switch (receipt.kind) {
    case "unknown_provider":
    case "unknown_school":
      return apiError(404, "not_found", "Not found.");
    case "invalid_signature":
      return apiError(401, "invalid_signature", "The callback signature is not valid.");
    case "accepted":
      after(() => processMobileMoneyCallbacks(db(), receipt.school).then(() => undefined));
      return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
    case "ignored":
    case "duplicate":
      return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
  }
}
