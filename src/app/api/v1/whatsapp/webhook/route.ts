import { timingSafeEqual } from "node:crypto";
import { db } from "@/server/db/client";
import { verifyWhatsAppSignature } from "@/server/notifications/whatsapp";
import { handleWhatsAppWebhook } from "@/server/notifications/whatsapp-webhook";
import { apiError } from "@/web/api";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

const sameText = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Meta's subscription check (WAB-01): set this URL and WHATSAPP_VERIFY_TOKEN as the webhook in the Meta app
 * dashboard; Meta sends hub.mode=subscribe with the token and expects hub.challenge back.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const expected = process.env.WHATSAPP_VERIFY_TOKEN?.trim() ?? "";
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  if (url.searchParams.get("hub.mode") !== "subscribe" || !expected || !sameText(token, expected))
    return apiError(403, "forbidden", "Verification failed.");
  return new Response(challenge.slice(0, 200), {
    headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
  });
}

/** Delivery statuses and replies, signed by Meta with the app secret (X-Hub-Signature-256). */
export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return apiError(413, "too_large", "Webhook too large.");
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return apiError(413, "too_large", "Webhook too large.");
  const secret = process.env.WHATSAPP_APP_SECRET?.trim() ?? "";
  if (!verifyWhatsAppSignature(rawBody, request.headers.get("x-hub-signature-256"), secret))
    return apiError(401, "invalid_signature", "The webhook signature is not valid.");
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return apiError(400, "invalid_body", "Not JSON.");
  }
  await handleWhatsAppWebhook(db(), body);
  return Response.json({ received: true }, { headers: { "Cache-Control": "no-store" } });
}
