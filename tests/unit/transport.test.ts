import { describe, expect, it } from "vitest";
import { allowed, PERMISSION_MODULES, type Access } from "@/server/authz/permissions";
import { planBilling, termBillingKey } from "@/server/fees/billing-plan";
import { MODULES } from "@/lib/modules";
import { directionAt, fareFor, ridesOn, tripState } from "@/lib/transport";

describe("transport rules (TRN)", () => {
  it("rides a trip both ways or one way, and charges the stop's fare over the route's (TRN-01c, TRN-02a)", () => {
    expect(ridesOn("both", "to_school")).toBe(true);
    expect(ridesOn("to_school", "from_school")).toBe(false);
    expect(ridesOn("from_school", "from_school")).toBe(true);
    expect(fareFor(45000, null)).toBe(45000);
    expect(fareFor(45000, 30000)).toBe(30000);
    // A stop can be free when the route is not.
    expect(fareFor(45000, 0)).toBe(0);
    expect(fareFor(null, null)).toBeNull();
  });

  it("follows a child from waiting to on the bus to off (TRN-03a)", () => {
    const at = new Date("2026-11-17T06:45:00Z");
    expect(tripState(undefined)).toBe("waiting");
    expect(tripState({ boardedAt: at, leftAt: null })).toBe("on_board");
    expect(tripState({ boardedAt: at, leftAt: new Date("2026-11-17T07:20:00Z") })).toBe("off");
    expect(directionAt(6)).toBe("to_school");
    expect(directionAt(15)).toBe("from_school");
  });

  it("bills the transport item from each student's fare instead of the structure (TRN-02b)", () => {
    const term = "t1";
    const enrolled = [
      { studentId: "a", classId: "c1", levelId: "l1" },
      { studentId: "b", classId: "c1", levelId: "l1" },
    ];
    // The structure also has a level amount for the transport item: ignored while fares decide it.
    const lines = [
      { feeItemId: "tuition", levelId: "l1", classId: null, amountPesewas: 100000 },
      { feeItemId: "bus", levelId: "l1", classId: null, amountPesewas: 99999 },
    ];
    const plan = planBilling(term, enrolled, lines, ["tuition", "bus"], [], () => true, {
      feeItemId: "bus",
      amounts: new Map([["a", 45000]]),
    });
    expect(plan.toCreate).toEqual([
      {
        studentId: "a",
        feeItemId: "tuition",
        amountPesewas: 100000,
        billingKey: termBillingKey(term, "tuition"),
      },
      { studentId: "a", feeItemId: "bus", amountPesewas: 45000, billingKey: termBillingKey(term, "bus") },
      {
        studentId: "b",
        feeItemId: "tuition",
        amountPesewas: 100000,
        billingKey: termBillingKey(term, "tuition"),
      },
    ]);

    // Billed already, then the fare changed and b was taken off: differences, never silent changes.
    const existing = [
      { studentId: "a", billingKey: termBillingKey(term, "tuition"), netPesewas: 100000 },
      { studentId: "a", billingKey: termBillingKey(term, "bus"), netPesewas: 45000 },
      { studentId: "b", billingKey: termBillingKey(term, "tuition"), netPesewas: 100000 },
      { studentId: "b", billingKey: termBillingKey(term, "bus"), netPesewas: 45000 },
    ];
    const again = planBilling(term, enrolled, lines, ["tuition", "bus"], existing, () => true, {
      feeItemId: "bus",
      amounts: new Map([["a", 50000]]),
    });
    expect(again.toCreate).toEqual([]);
    expect(again.differences).toEqual([
      { studentId: "a", feeItemId: "bus", billedPesewas: 45000, structurePesewas: 50000 },
      { studentId: "b", feeItemId: "bus", billedPesewas: 45000, structurePesewas: 0 },
    ]);
  });

  it("gives the office routes, staff on the bus trips, and the Accountant a view (TRN-04)", () => {
    const access = (role: Access["roles"][number]): Access => ({ roles: [role], features: ["transport"] });
    expect(allowed(access("admin"), "transport.manage")).toBe(true);
    expect(allowed(access("bursar"), "transport.view")).toBe(true);
    expect(allowed(access("bursar"), "transport.manage")).toBe(false);
    expect(allowed(access("teacher"), "transport.trips")).toBe(true);
    expect(allowed(access("teacher"), "transport.view")).toBe(false);
    expect(allowed({ roles: ["owner"], features: [] }, "transport.view")).toBe(false);
    for (const p of ["transport.view", "transport.manage", "transport.trips"] as const)
      expect(PERMISSION_MODULES[p]).toBe("transport");
    expect(MODULES.transport.routes).toEqual(["transport"]);
  });
});
