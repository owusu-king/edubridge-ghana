import { describe, expect, it } from "vitest";
import { allowed, assertAllowed, assertFeature, ForbiddenError } from "@/server/authz/permissions";
import { csvCell, toCsv } from "@/lib/csv";
import { pesewasToDecimal } from "@/lib/money";
import { FEATURES, monthLabel, monthOf, previousMonth } from "@/lib/plan";

describe("plan features", () => {
  const head = { roles: ["headteacher"] as const, features: [...FEATURES] };
  const noAttendance = { ...head, features: FEATURES.filter((f) => f !== "attendance") };

  it("allow a module only when the role may use it and the plan includes it", () => {
    expect(allowed(head, "attendance.take")).toBe(true);
    expect(allowed(noAttendance, "attendance.take")).toBe(false);
    // Core work is in every plan.
    expect(allowed({ roles: ["headteacher"], features: [] }, "students.manage")).toBe(true);
    expect(allowed({ roles: ["teacher"], features: [...FEATURES] }, "fees.remind")).toBe(false);
  });

  it("refuse with a permission error for the role, and a clear message for the plan", () => {
    expect(() => assertAllowed({ roles: ["teacher"], features: [] }, "fees.remind")).toThrow(ForbiddenError);
    expect(() => assertAllowed(noAttendance, "attendance.take")).toThrow(
      "Attendance is not included in this school's plan. Ask EduBridge to add it.",
    );
    expect(() => assertFeature({ roles: ["bursar"], features: [] }, "mobile_money")).toThrow(
      "Mobile Money is not included",
    );
  });
});

describe("billing months", () => {
  it("steps back across a year and labels months", () => {
    expect(monthOf("2026-11-06")).toBe("2026-11");
    expect(previousMonth("2026-11")).toBe("2026-10");
    expect(previousMonth("2027-01")).toBe("2026-12");
    expect(monthLabel("2026-11")).toBe("November 2026");
  });
});

describe("exports", () => {
  it("neutralise text a spreadsheet would run as a formula, but keep numbers", () => {
    expect(csvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(csvCell("+233245550101")).toBe("'+233245550101");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-50.00")).toBe("-50.00");
    expect(csvCell("-cmd")).toBe("'-cmd");
    expect(csvCell(-50)).toBe("-50");
    expect(csvCell(null)).toBe("");
  });

  it("write a UTF-8 file Excel opens correctly", () => {
    const csv = toCsv([
      ["Name", "Amount"],
      ["Ama, Mensah", "GH₵1.00"],
    ]);
    expect(csv).toBe(String.fromCharCode(0xfeff) + 'Name,Amount\r\n"Ama, Mensah",GH₵1.00\r\n');
  });

  it("write amounts as plain decimals", () => {
    expect(pesewasToDecimal(123_450)).toBe("1234.50");
    expect(pesewasToDecimal(-5_000)).toBe("-50.00");
    expect(pesewasToDecimal(7)).toBe("0.07");
  });
});
