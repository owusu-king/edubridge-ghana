import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { open, reseal, seal } from "@/server/auth/secret-box";

beforeAll(() => {
  process.env.MFA_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
});

describe("secret box", () => {
  it("encrypts with a fresh IV and decrypts", () => {
    const a = seal("JBSWY3DPEHPK3PXP");
    expect(a).not.toContain("JBSWY3DPEHPK3PXP");
    expect(seal("JBSWY3DPEHPK3PXP")).not.toBe(a);
    expect(open(a)).toBe("JBSWY3DPEHPK3PXP");
  });

  it("rejects tampered values", () => {
    const [v, iv, tag, ct] = seal("secret").split(".");
    const flipped = Buffer.from(ct!, "base64url");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => open([v, iv, tag, flipped.toString("base64url")].join("."))).toThrow();
  });
});

describe("rotating the encryption key", () => {
  it("opens values sealed with the previous key until they are sealed again with the new one", () => {
    const original = process.env.MFA_ENCRYPTION_KEY;
    try {
      const oldKey = randomBytes(32).toString("base64");
      process.env.MFA_ENCRYPTION_KEY = oldKey;
      const sealedOld = seal("JBSWY3DPEHPK3PXP");

      process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
      expect(() => open(sealedOld)).toThrow();
      process.env.MFA_ENCRYPTION_KEY_PREVIOUS = oldKey;
      expect(open(sealedOld)).toBe("JBSWY3DPEHPK3PXP");
      const sealedNew = reseal(sealedOld);
      delete process.env.MFA_ENCRYPTION_KEY_PREVIOUS;
      expect(open(sealedNew)).toBe("JBSWY3DPEHPK3PXP");
      expect(() => open(sealedOld)).toThrow();
    } finally {
      process.env.MFA_ENCRYPTION_KEY = original;
      delete process.env.MFA_ENCRYPTION_KEY_PREVIOUS;
    }
  });
});
