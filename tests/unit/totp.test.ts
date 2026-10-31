import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  totpAt,
  timeStep,
  verifyTotp,
} from "@/server/auth/totp";

// RFC 6238 Appendix B, SHA-1 seed "12345678901234567890", 8 digits.
const RFC_SECRET = Buffer.from("12345678901234567890");
const RFC_VECTORS: [number, string][] = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("TOTP", () => {
  it("matches the RFC 6238 test vectors", () => {
    for (const [seconds, expected] of RFC_VECTORS) {
      expect(totpAt(RFC_SECRET, Math.floor(seconds / 30), 8)).toBe(expected);
    }
  });

  it("round-trips base32", () => {
    const bytes = Buffer.from("synthetic secret bytes!");
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
  });

  it("verifies current codes within one step of drift and returns the step", () => {
    const secret = generateTotpSecret();
    const now = new Date("2026-10-31T12:00:10Z");
    const step = timeStep(now);
    const code = (s: number) => totpAt(base32Decode(secret), s);
    expect(verifyTotp(secret, code(step), now)).toBe(step);
    expect(verifyTotp(secret, code(step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, code(step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, code(step - 2), now)).toBeNull();
    expect(verifyTotp(secret, "12345", now)).toBeNull();
    expect(verifyTotp(secret, `${code(step).slice(0, 3)} ${code(step).slice(3)}`, now)).toBe(step);
  });

  it("builds an otpauth URI for authenticator apps", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "ama@example.test");
    expect(uri).toBe(
      "otpauth://totp/EduBridge%3Aama%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=EduBridge&algorithm=SHA1&digits=6&period=30",
    );
  });
});
