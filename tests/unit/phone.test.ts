import { describe, expect, it } from "vitest";
import { formatPhone, maskPhone, normalizePhone } from "@/lib/phone";

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
