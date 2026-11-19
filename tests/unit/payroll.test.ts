import { describe, expect, it } from "vitest";
import {
  SUGGESTED_COMPONENTS,
  calculatePay,
  formatBasisPoints,
  monthBounds,
  payrollTotals,
  percentOf,
} from "@/lib/payroll";

describe("payroll arithmetic (PRL-02c)", () => {
  it("rounds a percentage half up to a whole minor unit", () => {
    expect(percentOf(123_45, 550)).toBe(6_79); // 678.975 → 679
    expect(percentOf(100, 50)).toBe(1); // 0.5 → 1
    expect(percentOf(100, 49)).toBe(0);
    expect(() => percentOf(-1, 100)).toThrow();
    expect(() => percentOf(1.5, 100)).toThrow();
    expect(formatBasisPoints(550)).toBe("5.5%");
    expect(formatBasisPoints(1300)).toBe("13%");
  });

  it("builds gross from basic and earnings, takes deductions off, and keeps employer costs apart", () => {
    const line = calculatePay(
      2_500_00,
      [
        { name: "Transport", kind: "earning", basis: "fixed", value: 200_00 },
        { name: "Responsibility", kind: "earning", basis: "percent_basic", value: 1000 },
        { name: "SSNIT (employee)", kind: "deduction", basis: "percent_basic", value: 550 },
        { name: "Welfare", kind: "deduction", basis: "percent_gross", value: 100 },
        { name: "SSNIT (employer)", kind: "employer", basis: "percent_basic", value: 1300 },
      ],
      [
        { description: "October overtime", kind: "earning", amount: 50_00 },
        { description: "Salary advance", kind: "deduction", amount: 300_00 },
      ],
    );
    // Gross: 2,500 + 200 + 250 + 50 = 3,000. Deductions: 137.50 + 30 + 300 = 467.50.
    expect(line).toMatchObject({
      basic: 2_500_00,
      gross: 3_000_00,
      deductions: 467_50,
      net: 2_532_50,
      employer: 325_00,
    });
    expect(line.items.map((i) => [i.name, i.amount, i.basis])).toEqual([
      ["Transport", 200_00, null],
      ["Responsibility", 250_00, "10% of basic"],
      ["October overtime", 50_00, null],
      ["SSNIT (employee)", 137_50, "5.5% of basic"],
      ["Welfare", 30_00, "1% of gross"],
      ["Salary advance", 300_00, null],
      ["SSNIT (employer)", 325_00, "13% of basic"],
    ]);
  });

  it("never lets an earning depend on gross pay, and shows a negative net for the approver to refuse", () => {
    expect(() =>
      calculatePay(100_00, [{ name: "Bonus", kind: "earning", basis: "percent_gross", value: 100 }]),
    ).toThrow("an earning cannot be a share of gross pay");
    expect(calculatePay(100_00, [], [{ description: "Loan", kind: "deduction", amount: 150_00 }]).net).toBe(
      -50_00,
    );
  });

  it("totals a run and knows a month's first and last day", () => {
    const a = calculatePay(1_000_00, []);
    const b = calculatePay(2_000_00, [
      { name: "SSNIT (employer)", kind: "employer", basis: "percent_basic", value: 1300 },
    ]);
    expect(payrollTotals([a, b])).toEqual({
      people: 2,
      basic: 3_000_00,
      gross: 3_000_00,
      deductions: 0,
      net: 3_000_00,
      employer: 260_00,
    });
    expect(monthBounds("2028-02")).toEqual({ first: "2028-02-01", last: "2028-02-29" });
    expect(() => monthBounds("2026-13")).toThrow();
  });

  it("suggests component names without any statutory rate (PRL-01a)", () => {
    expect(SUGGESTED_COMPONENTS.map((c) => c.name)).toContain("SSNIT (employee)");
    expect(SUGGESTED_COMPONENTS.every((c) => !("value" in c))).toBe(true);
  });
});
