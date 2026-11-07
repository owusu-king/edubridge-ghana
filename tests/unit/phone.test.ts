import { describe, expect, it } from "vitest";
import { formatPhone, maskPhone, normalizeCallablePhone, normalizePhone } from "@/lib/phone";

describe("phone numbers", () => {
  it("normalises Ghanaian numbers from common formats", () => {
    for (const input of [
      "024 123 4567",
      "0241234567",
      "+233241234567",
      "233 24 123 4567",
      "(024) 123-4567",
    ]) {
      expect(normalizePhone(input), input).toBe("+233241234567");
    }
    expect(normalizePhone("0551234567")).toBe("+233551234567");
  });

  it("rejects invalid numbers", () => {
    for (const input of ["", "12345", "0341234567", "02412345678", "+23324123456", "abc", "+2330241234567"]) {
      expect(normalizePhone(input), input).toBeNull();
    }
  });

  it("accepts other countries in international format", () => {
    expect(normalizePhone("+234 803 123 4567")).toBe("+2348031234567");
    expect(normalizePhone("+254712345678")).toBe("+254712345678");
  });

  it("formats and masks", () => {
    expect(formatPhone("+233241234567")).toBe("+233 24 123 4567");
    expect(maskPhone("+233241234567")).toBe("+233••••••567");
  });
});

describe("numbers families can call", () => {
  it("accept Ghana landlines as well as mobiles, but never for SMS", () => {
    expect(normalizeCallablePhone("030 123 4567")).toBe("+233301234567");
    expect(normalizeCallablePhone("+233 32 202 2345")).toBe("+233322022345");
    expect(normalizeCallablePhone("024 123 4567")).toBe("+233241234567");
    expect(normalizePhone("030 123 4567")).toBeNull();
    expect(formatPhone("+233301234567")).toBe("+233 30 123 4567");
  });

  it("reject numbers that are neither", () => {
    for (const bad of ["12", "0301234", "040 123 4567", "0301234567890", "phone"])
      expect(normalizeCallablePhone(bad)).toBeNull();
  });
});
