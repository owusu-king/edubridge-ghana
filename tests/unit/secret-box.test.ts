import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { open, seal } from "@/server/auth/secret-box";

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
