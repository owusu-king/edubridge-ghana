import { describe, expect, it } from "vitest";
import { allowed, PERMISSION_MODULES, type Access } from "@/server/authz/permissions";
import { MODULES } from "@/lib/modules";
import { addDays, copyNumber, daysLate, fineFor, normalizeIsbn } from "@/lib/library";

describe("library rules (LIB)", () => {
  it("accepts ISBNs as printed, checks their check digit, and keeps the digits (LIB-01a)", () => {
    expect(normalizeIsbn("978-0-385-47454-2")).toBe("9780385474542");
    expect(normalizeIsbn("0 385 47454 7")).toBe("0385474547");
    expect(normalizeIsbn("0-8044-2957-x")).toBe("080442957X");
    expect(normalizeIsbn("9780385474543")).toBeNull();
    expect(normalizeIsbn("12345")).toBeNull();
  });

  it("counts calendar days late and caps the fine (LIB-02)", () => {
    expect(addDays("2026-11-17", 14)).toBe("2026-12-01");
    expect(addDays("2026-12-25", 14)).toBe("2027-01-08");
    expect(daysLate("2026-12-01", "2026-11-30")).toBe(0);
    expect(daysLate("2026-12-01", "2026-12-01")).toBe(0);
    expect(daysLate("2026-12-01", "2026-12-04")).toBe(3);
    const rules = { enabled: true, perDayMinor: 50, capMinor: 400 };
    expect(fineFor(3, rules)).toBe(150);
    expect(fineFor(30, rules)).toBe(400);
    expect(fineFor(3, { ...rules, capMinor: null })).toBe(150);
    expect(fineFor(3, { ...rules, enabled: false })).toBe(0);
    expect(fineFor(0, rules)).toBe(0);
    expect(copyNumber(12)).toBe("B0012");
  });

  it("lets every member of staff see the catalogue and the office run loans (LIB-03)", () => {
    const access = (role: Access["roles"][number]): Access => ({ roles: [role], features: ["library"] });
    expect(allowed(access("teacher"), "library.view")).toBe(true);
    expect(allowed(access("teacher"), "library.manage")).toBe(false);
    expect(allowed(access("admin"), "library.manage")).toBe(true);
    expect(allowed(access("bursar"), "library.manage")).toBe(false);
    expect(allowed({ roles: ["owner"], features: [] }, "library.view")).toBe(false);
    expect(PERMISSION_MODULES["library.view"]).toBe("library");
    expect(PERMISSION_MODULES["library.manage"]).toBe("library");
    expect(MODULES.library.routes).toEqual(["library"]);
  });
});
