import { describe, expect, it } from "vitest";
import { formatCedis, MAX_AMOUNT_PESEWAS, parseCedis, pesewasToInput, sumPesewas } from "@/lib/money";
import { resolveFees, totalFees, type StructureLine } from "@/server/fees/resolve";

describe("parseCedis", () => {
  it.each([
    ["450", 45000],
    ["450.5", 45050],
    ["450.50", 45050],
    ["0.05", 5],
    ["1,200.75", 120075],
    ["GH₵ 1 200", 120000],
    ["GHS50", 5000],
    ["  007 ", 700],
    ["0", 0],
    ["12.", 1200],
  ])("reads %s as %i pesewas", (text, pesewas) => {
    expect(parseCedis(text)).toBe(pesewas);
  });

  it.each(["", "abc", "-5", "1.234", "1e3", "12..5", "₵", "10000000.01", "999999999"])(
    "rejects %j",
    (text) => {
      expect(parseCedis(text)).toBeNull();
    },
  );

  it("accepts the maximum amount exactly", () => {
    expect(parseCedis("10000000")).toBe(MAX_AMOUNT_PESEWAS);
  });

  it("never introduces floating-point error", () => {
    // 0.1 + 0.2 style inputs stay exact because parsing is digit-based.
    expect(parseCedis("0.29")).toBe(29);
    expect(parseCedis("1.15")).toBe(115);
    expect(parseCedis("4.35")).toBe(435);
  });
});

describe("formatCedis", () => {
  it("formats pesewas with the cedi sign and two decimals", () => {
    expect(formatCedis(0)).toBe("GH₵0.00");
    expect(formatCedis(5)).toBe("GH₵0.05");
    expect(formatCedis(120075)).toBe("GH₵1,200.75");
    expect(formatCedis(100_000_000)).toBe("GH₵1,000,000.00");
    expect(formatCedis(-45050)).toBe("-GH₵450.50");
  });

  it("refuses non-integer amounts", () => {
    expect(() => formatCedis(1.5)).toThrow(RangeError);
  });

  it("round-trips through the input form", () => {
    for (const pesewas of [0, 5, 50, 45000, 45050, 120075]) {
      expect(parseCedis(pesewasToInput(pesewas))).toBe(pesewas);
    }
    expect(pesewasToInput(45000)).toBe("450");
    expect(pesewasToInput(45050)).toBe("450.50");
    expect(pesewasToInput(null)).toBe("");
  });
});

describe("sumPesewas", () => {
  it("adds exactly and rejects unsafe values", () => {
    expect(sumPesewas([10, 20, 70])).toBe(100);
    expect(sumPesewas([])).toBe(0);
    expect(() => sumPesewas([0.1, 0.2])).toThrow(RangeError);
    expect(() => sumPesewas([Number.MAX_SAFE_INTEGER, 1])).toThrow(RangeError);
  });
});

describe("resolveFees", () => {
  const lines: StructureLine[] = [
    { feeItemId: "tuition", levelId: "b4", classId: null, amountPesewas: 85000 },
    { feeItemId: "pta", levelId: "b4", classId: null, amountPesewas: 5000 },
    { feeItemId: "ict", levelId: "b4", classId: null, amountPesewas: 6000 },
    { feeItemId: "tuition", levelId: "b4", classId: "b4b", amountPesewas: 90000 },
    { feeItemId: "ict", levelId: "b4", classId: "b4b", amountPesewas: 0 },
    { feeItemId: "books", levelId: "b4", classId: "b4b", amountPesewas: 18000 },
    { feeItemId: "tuition", levelId: "jhs1", classId: null, amountPesewas: 110000 },
  ];
  const order = ["tuition", "pta", "books", "ict"];

  it("uses the level's amounts for a class without overrides", () => {
    const fees = resolveFees(lines, "b4", "b4a", order);
    expect(fees).toEqual([
      { feeItemId: "tuition", amountPesewas: 85000 },
      { feeItemId: "pta", amountPesewas: 5000 },
      { feeItemId: "ict", amountPesewas: 6000 },
    ]);
    expect(totalFees(fees)).toBe(96000);
  });

  it("applies class overrides, exemptions (zero) and class-only items", () => {
    const fees = resolveFees(lines, "b4", "b4b", order);
    expect(fees).toEqual([
      { feeItemId: "tuition", amountPesewas: 90000 },
      { feeItemId: "pta", amountPesewas: 5000 },
      { feeItemId: "books", amountPesewas: 18000 },
    ]);
    expect(totalFees(fees)).toBe(113000);
  });

  it("ignores other levels and returns nothing for a level without fees", () => {
    expect(resolveFees(lines, "kg1", "kg1", order)).toEqual([]);
    expect(totalFees(resolveFees(lines, "jhs1", "jhs1a", order))).toBe(110000);
  });
});
