import { describe, expect, it } from "vitest";
import { parseStatementDate, statementPeriod, type PeriodEntry } from "@/lib/statement";
import { statementRange } from "@/web/pdf/statement";

const entries: PeriodEntry[] = [
  { kind: "opening_balance", effectiveOn: "2026-08-31", amountPesewas: 20_000 },
  { kind: "charge", effectiveOn: "2026-09-08", amountPesewas: 100_000 },
  { kind: "discount", effectiveOn: "2026-09-08", amountPesewas: -10_000 },
  { kind: "payment", effectiveOn: "2026-09-15", amountPesewas: -50_000 },
  { kind: "reversal", effectiveOn: "2026-10-02", amountPesewas: 50_000 }, // a voided receipt
  { kind: "payment", effectiveOn: "2026-10-03", amountPesewas: -50_000 },
  { kind: "charge", effectiveOn: "2026-11-01", amountPesewas: 5_000 },
];
const total = entries.reduce((sum, e) => sum + e.amountPesewas, 0);

describe("statements for a date range", () => {
  it("opening + charges − payments ± adjustments = closing, and the closing equals the ledger to that day", () => {
    const october = statementPeriod(entries, "2026-10-01", "2026-10-31");
    expect(october).toMatchObject({
      openingPesewas: 60_000,
      chargesPesewas: 0,
      paymentsPesewas: 50_000,
      adjustmentsPesewas: 50_000,
      closingPesewas: 60_000,
    });
    expect(october.entries).toHaveLength(2);

    // Any split agrees with the ledger.
    for (const [from, to] of [
      ["2026-09-01", "2026-09-30"],
      ["2026-09-08", "2026-09-08"],
      ["2026-01-01", "2026-12-31"],
      ["2026-11-02", "2026-11-30"],
    ] as const) {
      const p = statementPeriod(entries, from, to);
      expect(p.closingPesewas).toBe(
        p.openingPesewas + p.chargesPesewas - p.paymentsPesewas + p.adjustmentsPesewas,
      );
      const upTo = entries.filter((e) => e.effectiveOn <= to).reduce((sum, e) => sum + e.amountPesewas, 0);
      expect(p.closingPesewas).toBe(upTo);
    }
    expect(statementPeriod(entries, null, null).closingPesewas).toBe(total);
  });

  it("reads the range from the address, never past today", () => {
    const at = (qs: string) => statementRange(new Request(`https://x.test/statement${qs}`), "2026-11-09");
    expect(at("")).toEqual({ from: null, to: null });
    expect(at("?from=2026-09-01&to=2026-09-30")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(at("?from=2026-09-01")).toEqual({ from: "2026-09-01", to: "2026-11-09" });
    expect(at("?from=2026-09-01&to=2027-01-01")).toEqual({ from: "2026-09-01", to: "2026-11-09" });
    expect(at("?from=2026-10-01&to=2026-09-01")).toBeNull();
    expect(at("?from=2026-02-30")).toBeNull();
    expect(at("?to=yesterday")).toBeNull();
    expect(parseStatementDate("2026-13-01")).toBeNull();
  });
});
