import { createHash, randomBytes } from "node:crypto";

/** 256-bit random secret, base64url encoded. Given to the client, never stored. */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 of a secret token, which is what gets stored, so a database leak does not leak tokens. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const generateSessionToken = generateToken;
export const sessionIdFromToken = hashToken;
