import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/server/auth/password";

describe("password hashing", () => {
  it("verifies the correct password and rejects others", async () => {
    const hash = await hashPassword("a long synthetic passphrase");
    expect(hash.startsWith("scrypt$32768$8$1$")).toBe(true);
    expect(await verifyPassword("a long synthetic passphrase", hash)).toBe(true);
    expect(await verifyPassword("a long synthetic passphrasE", hash)).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same password")).not.toEqual(await hashPassword("same password"));
  });

  it("rejects malformed stored hashes without throwing", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$abc")).toBe(false);
  });

  it("normalises unicode so visually identical passwords match", async () => {
    const hash = await hashPassword("café-password");
    expect(await verifyPassword("café-password", hash)).toBe(true);
  });
});
