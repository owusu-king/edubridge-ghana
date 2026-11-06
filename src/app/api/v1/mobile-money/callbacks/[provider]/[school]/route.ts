import { after } from "next/server";
import { db } from "@/server/db/client";
import { processMobileMoneyCallbacks, receiveMobileMoneyCallback } from "@/server/mobile-money/callbacks";
import { apiError } from "@/web/api";

export const dynamic = "force-dynamic";

/** Callbacks are small; anything larger is not from a provider. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Mobile Money provider callbacks for one school. Public (providers cannot sign in), so the provider's
 * signature is checked before anything is stored. The callback is stored, acknowledged, and processed
 * after the response; the worker picks up anything that does not finish.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string; school: string }> },
) {
  const { provider, school } = await params;
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return apiError(413, "too_large", "Callback too large.");
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return apiError(413, "too_large", "Callback too large.");

  const receipt = await receiveMobileMoneyCallback(db(), {
    providerName: provider,
    tenantId: school,
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
    case "duplicate":
      return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
  }
}
