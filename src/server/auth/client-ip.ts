import { isIP } from "node:net";

/**
 * The client's network address, for rate limits and sign-in records.
 *
 * Proxies append the address they received the request from to X-Forwarded-For, so only the entries
 * added by EduBridge's own proxies can be trusted; anything to their left was written by the client and
 * can be anything. With `TRUSTED_PROXY_HOPS` proxies in front of the app (default 1: one load balancer or
 * reverse proxy), the client is the entry that many places from the right. Without a proxy, Next.js
 * fills the header from the socket when the client did not send one, which is the rightmost entry too.
 *
 * Reading the leftmost entry (as before) let anyone pick their own address and step around the limits
 * per network address on sign-in codes, application codes and password resets.
 */
type ProxyEnv = Readonly<Record<string, string | undefined>>;

export function clientIpFrom(headers: Headers, env: ProxyEnv = process.env): string | null {
  const hops = trustedProxyHops(env);
  const entries = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const candidate = entries.length >= hops ? entries[entries.length - hops] : undefined;
  return candidate && isIP(candidate) ? candidate : null;
}

function trustedProxyHops(env: ProxyEnv): number {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return 1;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 1 || hops > 5)
    throw new Error("TRUSTED_PROXY_HOPS must be a whole number from 1 to 5.");
  return hops;
}
