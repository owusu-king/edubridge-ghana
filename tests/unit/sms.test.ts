import { describe, expect, it } from "vitest";
import { announcementSms, feeReminderSms } from "@/lib/fee-messages";
import { smsSegments, smsSize } from "@/lib/sms";

describe("SMS segments", () => {
  it("fits 160 plain characters in one SMS and 153 per part after that", () => {
    expect(smsSize("a".repeat(160))).toEqual({ encoding: "gsm7", units: 160, segments: 1 });
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("a".repeat(306))).toBe(2);
    expect(smsSegments("a".repeat(307))).toBe(3);
  });

  it("counts extension characters twice", () => {
    expect(smsSize("€".repeat(80))).toMatchObject({ encoding: "gsm7", units: 160, segments: 1 });
    expect(smsSegments("€".repeat(81))).toBe(2);
    expect(smsSize("[x]")).toMatchObject({ units: 5 });
  });

  it("sends the whole text as Unicode when one character is not in the GSM alphabet", () => {
    expect(smsSize("GH₵ 1,120.00")).toMatchObject({ encoding: "ucs2", segments: 1 });
    expect(smsSegments("₵" + "a".repeat(69))).toBe(1);
    expect(smsSegments("₵" + "a".repeat(70))).toBe(2);
    expect(smsSegments("₵" + "a".repeat(134))).toBe(3);
    // An emoji outside the Basic Multilingual Plane takes two units.
    expect(smsSize("👍")).toMatchObject({ encoding: "ucs2", units: 2 });
  });

  it("is at least one for an empty text", () => {
    expect(smsSegments("")).toBe(1);
  });

  it("keeps a typical fee reminder to one SMS (amounts written GHS, not ₵)", () => {
    const text = feeReminderSms({
      schoolName: "Kpone Ridge International School",
      studentFirstName: "Kwame",
      balancePesewas: 112_000,
      currency: "GHS",
    });
    expect(smsSize(text).encoding).toBe("gsm7");
  });

  it("keeps letters from the GSM alphabet (é, à) in a 7-bit SMS", () => {
    expect(smsSize("Journée portes ouvertes à l'école").encoding).toBe("gsm7");
  });

  it("makes a long announcement title take more than one SMS", () => {
    const short = announcementSms({
      schoolName: "Kpone Ridge",
      title: "Sports day",
      link: "https://x.test/p",
    });
    const accented = announcementSms({
      schoolName: "Kpone Ridge",
      title: "Réunion des parents: leçons et progrès",
      link: "https://x.test/p",
    });
    expect(smsSegments(short)).toBe(1);
    expect(smsSize(accented).encoding).toBe("ucs2");
    expect(smsSegments(accented)).toBe(2);
  });
});
