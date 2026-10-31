import { describe, expect, it } from "vitest";
import { planBilling, termBillingKey } from "@/server/fees/billing-plan";
import type { StructureLine } from "@/server/fees/resolve";

const T = "term-1";
const lines: StructureLine[] = [
  { feeItemId: "tuition", levelId: "b4", classId: null, amountPesewas: 85000 },
  { feeItemId: "pta", levelId: "b4", classId: null, amountPesewas: 5000 },
  { feeItemId: "tuition", levelId: "b4", classId: "b4b", amountPesewas: 90000 },
];
const order = ["tuition", "pta"];
const ama = { studentId: "ama", classId: "b4a", levelId: "b4" };
const kofi = { studentId: "kofi", classId: "b4b", levelId: "b4" };
const kg = { studentId: "kg", classId: "kg1", levelId: "kg" };

describe("planBilling", () => {
  it("charges each student their class's fees once per item", () => {
    const plan = planBilling(T, [ama, kofi, kg], lines, order, []);
    expect(plan.toCreate).toEqual([
      {
        studentId: "ama",
        feeItemId: "tuition",
        amountPesewas: 85000,
        billingKey: termBillingKey(T, "tuition"),
      },
      { studentId: "ama", feeItemId: "pta", amountPesewas: 5000, billingKey: termBillingKey(T, "pta") },
      {
        studentId: "kofi",
        feeItemId: "tuition",
        amountPesewas: 90000,
        billingKey: termBillingKey(T, "tuition"),
      },
      { studentId: "kofi", feeItemId: "pta", amountPesewas: 5000, billingKey: termBillingKey(T, "pta") },
    ]);
    expect(plan.differences).toEqual([]);
    expect(plan.billedStudents).toBe(0);
  });

  it("is idempotent: nothing to create once everything is billed", () => {
    const first = planBilling(T, [ama, kofi], lines, order, []);
    const existing = first.toCreate.map((c) => ({
      studentId: c.studentId,
      billingKey: c.billingKey,
      netPesewas: c.amountPesewas,
    }));
    const second = planBilling(T, [ama, kofi], lines, order, existing);
    expect(second.toCreate).toEqual([]);
    expect(second.differences).toEqual([]);
    expect(second.billedStudents).toBe(2);
  });

  it("bills only what is missing, and ignores other terms' charges", () => {
    const existing = [
      { studentId: "ama", billingKey: termBillingKey(T, "tuition"), netPesewas: 85000 },
      { studentId: "ama", billingKey: termBillingKey("term-0", "pta"), netPesewas: 5000 },
    ];
    const plan = planBilling(T, [ama], lines, order, existing);
    expect(plan.toCreate.map((c) => c.feeItemId)).toEqual(["pta"]);
  });

  it("reports changed amounts and dropped items instead of changing charges", () => {
    const existing = [
      { studentId: "kofi", billingKey: termBillingKey(T, "tuition"), netPesewas: 85000 },
      { studentId: "kofi", billingKey: termBillingKey(T, "pta"), netPesewas: 5000 },
      { studentId: "kofi", billingKey: termBillingKey(T, "books"), netPesewas: 18000 },
    ];
    const plan = planBilling(T, [kofi], lines, order, existing);
    expect(plan.toCreate).toEqual([]);
    expect(plan.differences).toEqual([
      { studentId: "kofi", feeItemId: "tuition", billedPesewas: 85000, structurePesewas: 90000 },
      { studentId: "kofi", feeItemId: "books", billedPesewas: 18000, structurePesewas: 0 },
    ]);
  });

  it("re-bills an item once every earlier charge for it was reversed, with a new key", () => {
    const existing = [
      { studentId: "kofi", billingKey: termBillingKey(T, "tuition"), netPesewas: 0 },
      { studentId: "kofi", billingKey: termBillingKey(T, "pta"), netPesewas: 5000 },
    ];
    const plan = planBilling(T, [kofi], lines, order, existing);
    expect(plan.toCreate).toEqual([
      {
        studentId: "kofi",
        feeItemId: "tuition",
        amountPesewas: 90000,
        billingKey: `term:${T}:item:tuition:2`,
      },
    ]);
    const again = planBilling(T, [kofi], lines, order, [
      ...existing,
      { studentId: "kofi", billingKey: `term:${T}:item:tuition:2`, netPesewas: 0 },
    ]);
    expect(again.toCreate[0]!.billingKey).toBe(`term:${T}:item:tuition:3`);
  });

  it("does not report reversed charges for items no longer in the structure", () => {
    const existing = [{ studentId: "ama", billingKey: termBillingKey(T, "books"), netPesewas: 0 }];
    expect(planBilling(T, [ama], lines, order, existing).differences).toEqual([]);
  });
});
