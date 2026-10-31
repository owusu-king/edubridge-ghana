import { createHash, randomBytes } from "node:crypto";

/** 256-bit random session token, base64url encoded. Given to the client, never stored. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Session id stored in the database: SHA-256 of the token, so a database leak does not leak sessions. */
export function sessionIdFromToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
