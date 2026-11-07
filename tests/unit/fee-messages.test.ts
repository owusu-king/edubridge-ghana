import { describe, expect, it } from "vitest";
import { TEMPLATES } from "@/server/notifications/templates";
import {
  feeReminderMessage,
  feeReminderSms,
  formatCedisSms,
  receiptMessage,
  whatsappLink,
} from "@/lib/fee-messages";
import { describeReminders } from "@/web/reminders";

/** Characters an SMS can carry in the cheap 7-bit alphabet (160 per message). Anything else halves it. */
const GSM_7 = /^[A-Za-z0-9 @£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà]*$/;

describe("SMS fee reminder", () => {
  it("is one plain SMS with the balance for a typical school name", () => {
    const { text } = TEMPLATES.fee_reminder({
      schoolName: "Kpone Ridge International School",
      studentFirstName: "Efua",
      balancePesewas: 112050,
    });
    expect(text).toBe(
      "Kpone Ridge International School: Efua's school fees balance is GHS 1,120.50. Please pay at the school office or by Mobile Money. Thank you.",
    );
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text).toMatch(GSM_7);
  });

  it("fits the balance link in one SMS for a typical school name", () => {
    const link = "https://app.edubridge.africa/b/Xy3_abcDEFghiJKLmnoPQr";
    const text = feeReminderSms({
      schoolName: "Kpone Ridge International School",
      studentFirstName: "Efua",
      balancePesewas: 112050,
      link,
    });
    expect(text).toBe(
      `Kpone Ridge International School: Efua's school fees balance is GHS 1,120.50. See details: ${link}`,
    );
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text).toMatch(GSM_7);
  });

  it("stays plain GSM text for large balances and long names, at most two SMS", () => {
    const text = feeReminderSms({
      schoolName: "The Very Long Named International Academy of Excellence and Leadership, Accra",
      studentFirstName: "Oheneba-Kwadwo",
      balancePesewas: 999_999_999,
    });
    expect(text.startsWith("The Very Long Named International Academy of Exce.: ")).toBe(true);
    expect(text).toContain("GHS 9,999,999.99");
    expect(text).toMatch(GSM_7);
    expect(text.length).toBeLessThanOrEqual(306);
  });

  it("leaves the amount out when there is no positive balance", () => {
    for (const balancePesewas of [undefined, 0, -500, 1.5]) {
      expect(feeReminderSms({ schoolName: "Kpone Ridge", studentFirstName: "Kofi", balancePesewas })).toBe(
        "Kpone Ridge: a reminder that Kofi's school fees are outstanding. Please pay at the school office or by Mobile Money. Thank you.",
      );
    }
    expect(formatCedisSms(500)).toBe("GHS 5.00");
  });
});

describe("WhatsApp messages", () => {
  it("builds a reminder with the balance, and a link that opens a chat with the guardian", () => {
    const text = feeReminderMessage({
      schoolName: "Kpone Ridge International School",
      studentName: "Kojo Addo",
      balancePesewas: 112000,
    });
    expect(text).toBe(
      "Hello, this is Kpone Ridge International School. Kojo Addo's school fees balance is GH₵1,120.00. Please pay at the school office or by Mobile Money. Thank you.",
    );
    const link = whatsappLink("+233275550133", text);
    expect(link.startsWith("https://wa.me/233275550133?text=")).toBe(true);
    expect(decodeURIComponent(new URL(link).search.slice("?text=".length))).toBe(text);
  });

  it("summarises a receipt", () => {
    expect(
      receiptMessage({
        schoolName: "Kpone Ridge",
        receiptNumber: "R000005",
        amountPesewas: 114000,
        studentName: "Yaw Darko",
        paidOn: "2026-11-04",
        balanceAfterPesewas: 0,
      }),
    ).toBe(
      "Kpone Ridge: receipt R000005. GH₵1,140.00 received for Yaw Darko on 4 Nov 2026. Balance: nothing owed. Thank you.",
    );
  });
});

describe("reminder summary", () => {
  it("says what was sent and why others were skipped", () => {
    expect(describeReminders({ sent: 3, skipped: [] })).toBe("Sent 3 reminders.");
    expect(
      describeReminders({
        sent: 1,
        skipped: [
          { studentId: "a", reason: "no_phone" },
          { studentId: "b", reason: "no_phone" },
          { studentId: "c", reason: "already_today" },
        ],
      }),
    ).toBe("Sent 1 reminder. 3 skipped: 2 have no guardian phone number, 1 was already reminded today.");
    expect(describeReminders({ sent: 0, skipped: [{ studentId: "a", reason: "not_owing" }] })).toBe(
      "No reminders sent. 1 skipped: 1 owes nothing.",
    );
  });
});

describe("payment receipt SMS", () => {
  const base = {
    schoolName: "Kpone Ridge International School",
    studentFirstName: "Efua",
    amountPesewas: 45_000,
    receiptNumber: "R000123",
  };

  it("gives the amount, receipt number and balance in one plain SMS", () => {
    const { text } = TEMPLATES.payment_receipt({ ...base, balancePesewas: 120_050 });
    expect(text).toBe(
      "Kpone Ridge International School: GHS 450.00 received for Efua, receipt R000123. Balance now GHS 1,200.50. Thank you.",
    );
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text).toMatch(GSM_7);
  });

  it("says when fees are fully paid or in credit", () => {
    expect(TEMPLATES.payment_receipt({ ...base, balancePesewas: 0 }).text).toContain("Fees fully paid.");
    expect(TEMPLATES.payment_receipt({ ...base, balancePesewas: -2_500 }).text).toContain(
      "GHS 25.00 in credit.",
    );
  });

  it("stays within one SMS for long school names", () => {
    const { text } = TEMPLATES.payment_receipt({
      ...base,
      schoolName: "The Very Long Name Preparatory and International Academy of Greater Accra",
      balancePesewas: 9_999_999,
    });
    expect(text.length).toBeLessThanOrEqual(160);
    expect(text).toMatch(GSM_7);
  });
});

describe("announcement SMS", () => {
  it("carries the title and the parent view link", () => {
    const { text } = TEMPLATES.announcement({
      schoolName: "Kpone Ridge International School",
      title: "School closes early on Friday",
    });
    expect(text).toMatch(
      /^Kpone Ridge International School: School closes early on Friday\. Read it here: \S+\/p$/,
    );
    expect(text).toMatch(GSM_7);
  });

  it("shortens long titles so the link still fits in two SMS", () => {
    const { text } = TEMPLATES.announcement({ schoolName: "A School", title: "x".repeat(200) });
    expect(text).toContain("x".repeat(90) + ".");
    expect(text).not.toContain("x".repeat(91));
    expect(text.length).toBeLessThanOrEqual(306);
  });
});
