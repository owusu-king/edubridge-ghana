import { describe, expect, it } from "vitest";
import { generateSessionToken, sessionIdFromToken } from "@/server/auth/tokens";

describe("session tokens", () => {
  it("generates 256-bit url-safe tokens", () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateSessionToken()).not.toEqual(token);
  });

  it("stores a deterministic hash, never the token", () => {
    const token = generateSessionToken();
    expect(sessionIdFromToken(token)).toEqual(sessionIdFromToken(token));
    expect(sessionIdFromToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(sessionIdFromToken(token)).not.toContain(token);
  });
});
