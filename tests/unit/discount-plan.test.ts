import { describe, expect, it } from "vitest";
import {
  discountBillingKey,
  percentOf,
  planDiscounts,
  type ConcessionRule,
} from "@/server/fees/discount-plan";

const T = "t1";
const bases = [
  { studentId: "ama", feeItemId: "tuition", amountPesewas: 85000 },
  { studentId: "ama", feeItemId: "pta", amountPesewas: 5000 },
  { studentId: "kofi", feeItemId: "tuition", amountPesewas: 85000 },
];
const rule = (r: Partial<ConcessionRule> & { id: string; studentId: string }): ConcessionRule => ({
  feeItemId: null,
  percentBasisPoints: null,
  amountPesewas: null,
  ...r,
});

describe("percentOf", () => {
  it("rounds half up in whole pesewas", () => {
    expect(percentOf(85000, 1000)).toBe(8500);
    expect(percentOf(333, 5000)).toBe(167);
    expect(percentOf(333, 3333)).toBe(111);
    expect(percentOf(1, 5000)).toBe(1);
    expect(percentOf(1_000_000_000, 10000)).toBe(1_000_000_000);
  });
});

describe("planDiscounts", () => {
  it("applies a percentage to every item, or to one item", () => {
    const plan = planDiscounts(
      T,
      bases,
      [rule({ id: "c1", studentId: "ama", percentBasisPoints: 1000 })],
      [],
    );
    expect(plan).toEqual([
      {
        studentId: "ama",
        feeItemId: "tuition",
        concessionId: "c1",
        amountPesewas: -8500,
        billingKey: discountBillingKey("c1", T, "tuition"),
      },
      {
        studentId: "ama",
        feeItemId: "pta",
        concessionId: "c1",
        amountPesewas: -500,
        billingKey: discountBillingKey("c1", T, "pta"),
      },
    ]);
    const tuitionOnly = planDiscounts(
      T,
      bases,
      [rule({ id: "c2", studentId: "kofi", feeItemId: "tuition", percentBasisPoints: 2500 })],
      [],
    );
    expect(tuitionOnly.map((d) => [d.studentId, d.feeItemId, d.amountPesewas])).toEqual([
      ["kofi", "tuition", -21250],
    ]);
  });

  it("caps fixed amounts and stacked concessions at the charge", () => {
    const plan = planDiscounts(
      T,
      bases,
      [
        rule({ id: "half", studentId: "ama", feeItemId: "pta", percentBasisPoints: 5000 }),
        rule({ id: "fixed", studentId: "ama", feeItemId: "pta", amountPesewas: 4000 }),
        rule({ id: "more", studentId: "ama", feeItemId: "pta", amountPesewas: 100 }),
      ],
      [],
    );
    expect(plan.map((d) => [d.concessionId, d.amountPesewas])).toEqual([
      ["half", -2500],
      ["fixed", -2500],
    ]);
  });

  it("is idempotent and counts discounts already given towards the cap", () => {
    const concessions = [
      rule({ id: "full", studentId: "kofi", percentBasisPoints: 10000 }),
      rule({ id: "extra", studentId: "kofi", feeItemId: "tuition", amountPesewas: 1000 }),
    ];
    const first = planDiscounts(T, bases, concessions, []);
    expect(first.map((d) => [d.concessionId, d.amountPesewas])).toEqual([["full", -85000]]);
    const existing = first.map((d) => ({
      studentId: d.studentId,
      billingKey: d.billingKey,
      netPesewas: d.amountPesewas,
    }));
    expect(planDiscounts(T, bases, concessions, existing)).toEqual([]);
  });

  it("does not re-apply a discount that was reversed, and ignores other terms", () => {
    const existing = [
      { studentId: "ama", billingKey: discountBillingKey("c1", T, "tuition"), netPesewas: 0 },
    ];
    const plan = planDiscounts(
      T,
      bases,
      [rule({ id: "c1", studentId: "ama", feeItemId: "tuition", percentBasisPoints: 1000 })],
      existing,
    );
    expect(plan).toEqual([]);
    const otherTerm = [
      { studentId: "ama", billingKey: discountBillingKey("c1", "t0", "tuition"), netPesewas: -8500 },
    ];
    expect(
      planDiscounts(
        T,
        bases,
        [rule({ id: "c1", studentId: "ama", feeItemId: "tuition", percentBasisPoints: 1000 })],
        otherTerm,
      ),
    ).toHaveLength(1);
  });

  it("skips items with no live charge", () => {
    expect(
      planDiscounts(
        T,
        [{ studentId: "ama", feeItemId: "tuition", amountPesewas: 0 }],
        [rule({ id: "c", studentId: "ama", percentBasisPoints: 1000 })],
        [],
      ),
    ).toEqual([]);
  });
});
