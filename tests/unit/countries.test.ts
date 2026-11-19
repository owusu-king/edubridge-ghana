import { describe, expect, it } from "vitest";
import { COUNTRY_CODES, COUNTRY_PROFILES, countryForNumber, countryProfile } from "@/lib/countries";
import { suggestedHolidays } from "@/lib/holidays";
import { networksFor } from "@/lib/mobile-money";
import { formatMoney, formatMoneySms, minorDigits, parseMoney } from "@/lib/money";
import { formatPhone, localizePhoneField, normalizeCallablePhone, normalizePhone } from "@/lib/phone";

describe("country profiles", () => {
  it("are complete and consistent", () => {
    for (const code of COUNTRY_CODES) {
      const p = COUNTRY_PROFILES[code];
      expect(p.code).toBe(code);
      expect(p.currency).toMatch(/^[A-Z]{3}$/);
      expect(p.dialCode).toMatch(/^[1-9]\d{0,2}$/);
      // The display grouping covers a whole mobile number.
      const sample = {
        GH: "241234567",
        NG: "8031234567",
        KE: "712345678",
        UG: "772123456",
        TZ: "712345678",
        RW: "788123456",
        ZM: "971234567",
        ZA: "821234567",
        CI: "0701020304",
        SN: "771234567",
        CM: "671234567",
      }[code];
      expect(p.mobile.test(sample)).toBe(true);
      expect(p.grouping.reduce((a, b) => a + b, 0)).toBe(sample.length);
      expect(() => new Intl.DateTimeFormat("en", { timeZone: p.timezone })).not.toThrow();
    }
    expect(countryProfile("XX").code).toBe("GH");
    expect(countryForNumber("+27821234567")?.code).toBe("ZA");
    expect(countryForNumber("+260971234567")?.code).toBe("ZM");
    expect(countryForNumber("+12025550123")).toBeNull();
  });
});

describe("phone numbers by country", () => {
  it("keeps Ghana's rules", () => {
    expect(normalizePhone("024 123 4567")).toBe("+233241234567");
    expect(normalizePhone("+233 24 123 4567")).toBe("+233241234567");
    expect(normalizePhone("233241234567")).toBe("+233241234567");
    expect(normalizePhone("030 123 4567")).toBeNull(); // a landline, not a mobile
    expect(normalizeCallablePhone("030 123 4567")).toBe("+233301234567");
  });

  it("reads numbers in the national form of the school's country", () => {
    expect(normalizePhone("0712 345 678", "KE")).toBe("+254712345678");
    expect(normalizePhone("0803 123 4567", "NG")).toBe("+2348031234567");
    expect(normalizePhone("0772 123 456", "UG")).toBe("+256772123456");
    expect(normalizePhone("07 01 02 03 04", "CI")).toBe("+2250701020304");
    expect(normalizePhone("77 123 45 67", "SN")).toBe("+221771234567");
    expect(normalizePhone("082 123 4567", "ZA")).toBe("+27821234567");
    // A Ghanaian school still reads a Kenyan number written internationally, but not in Kenyan form.
    expect(normalizePhone("+254 712 345 678")).toBe("+254712345678");
    expect(normalizePhone("0712 345 678")).toBeNull();
    // Known countries are checked against their numbering; others are accepted internationally.
    expect(normalizePhone("+254 112")).toBeNull();
    expect(normalizePhone("+44 7700 900123")).toBe("+447700900123");
  });

  it("formats stored numbers the way their country writes them", () => {
    expect(formatPhone("+233241234567")).toBe("+233 24 123 4567");
    expect(formatPhone("+254712345678")).toBe("+254 712 345 678");
    expect(formatPhone("+2348031234567")).toBe("+234 803 123 4567");
    expect(formatPhone("+2250701020304")).toBe("+225 07 01 02 03 04");
    expect(formatPhone("+447700900123")).toBe("+447700900123");
  });

  it("puts a national number into international form before a country-blind check", () => {
    expect(localizePhoneField({ phone: "0712 345 678", name: "A" }, "KE")).toEqual({
      phone: "+254712345678",
      name: "A",
    });
    expect(localizePhoneField({ phone: "not a number" }, "KE")).toEqual({ phone: "not a number" });
  });
});

/** Intl separates symbol and amount with a no-break space; compare as plain spaces. */
const plain = (text: string) => text.replace(/[  ]/g, " ");

describe("money in each currency", () => {
  it("uses each currency's minor unit and symbol, exactly", () => {
    expect(minorDigits("GHS")).toBe(2);
    expect(minorDigits("UGX")).toBe(0);
    expect(minorDigits("XOF")).toBe(0);
    expect(formatMoney(120075, "GHS")).toBe("GH₵1,200.75");
    expect(formatMoney(120075, "NGN")).toBe("₦1,200.75");
    expect(plain(formatMoney(-5, "KES"))).toBe("-Ksh 0.05");
    expect(plain(formatMoney(50000, "UGX"))).toBe("USh 50,000");
    // 0.1 + 0.2 style errors cannot happen: the minor part is never a float.
    expect(formatMoney(30, "USD")).toBe("$0.30");
  });

  it("parses typed amounts per currency", () => {
    expect(parseMoney("1,200.75", "NGN")).toBe(120075);
    expect(parseMoney("KES 1 200.5", "KES")).toBe(120050);
    expect(parseMoney("USh 50,000", "UGX")).toBe(50000);
    expect(parseMoney("50.5", "UGX")).toBeNull(); // no minor unit
    expect(parseMoney("1.234", "KES")).toBeNull();
    expect(parseMoney("-5", "KES")).toBeNull();
    expect(parseMoney(formatMoney(98765, "XAF"), "XAF")).toBe(98765);
    expect(parseMoney("GH₵ 1 200.50", "GHS")).toBe(120050);
  });

  it("writes SMS amounts with the ISO code, in plain characters", () => {
    expect(formatMoneySms(112000, "GHS")).toBe("GHS 1,120.00");
    expect(formatMoneySms(50000, "UGX")).toBe("UGX 50,000");
    expect(formatMoneySms(250000, "XOF")).toBe("XOF 250,000");
  });
});

describe("holidays and networks by country", () => {
  it("suggests each country's fixed and Easter holidays", () => {
    const ke = suggestedHolidays("KE", "2027-01-01", "2027-12-31").map((h) => h.name);
    expect(ke).toContain("Madaraka Day");
    expect(ke).toContain("Good Friday");
    expect(ke).not.toContain("Independence Day");
    const ci = suggestedHolidays("CI", "2027-01-01", "2027-12-31").map((h) => h.name);
    expect(ci).toContain("Fête de l'Indépendance");
    expect(ci).not.toContain("Good Friday");
    expect(suggestedHolidays("GH", "2027-12-01", "2027-12-31").map((h) => h.name)).toContain("Farmers' Day");
    expect(suggestedHolidays("XX", "2027-01-01", "2027-12-31")).toEqual([]);
  });

  it("lists the Mobile Money networks payers use in each country", () => {
    expect(networksFor("GH").map((n) => n.id)).toEqual(["mtn", "telecel", "at"]);
    expect(networksFor("KE").map((n) => n.id)).toEqual(["mpesa", "airtel"]);
    expect(networksFor("ZA")).toEqual([]);
  });
});
