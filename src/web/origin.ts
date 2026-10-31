import "server-only";
import { headers } from "next/headers";

/**
 * Public origin for links we hand out (e.g. invitations). APP_URL wins when set — required in production,
 * where the Host header must not be trusted for link generation.
 */
export async function appOrigin(): Promise<string> {
  const configured = process.env.APP_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (process.env.NODE_ENV === "production") throw new Error("APP_URL must be set in production.");
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  return `${host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https"}://${host}`;
}
