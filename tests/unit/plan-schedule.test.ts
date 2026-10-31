import { describe, expect, it } from "vitest";
import { planProgress, splitInstalments } from "@/server/fees/plan-schedule";

describe("splitInstalments", () => {
  it("splits equally with the remainder on the last instalment", () => {
    expect(splitInstalments(100000, 3, "2026-10-15", "monthly")).toEqual([
      { sequence: 1, dueOn: "2026-10-15", amountPesewas: 33333 },
      { sequence: 2, dueOn: "2026-11-15", amountPesewas: 33333 },
      { sequence: 3, dueOn: "2026-12-15", amountPesewas: 33334 },
    ]);
  });

  it("keeps month ends sensible and supports fortnightly and weekly", () => {
    expect(splitInstalments(4000, 4, "2027-01-31", "monthly").map((i) => i.dueOn)).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
    ]);
    expect(splitInstalments(300, 3, "2026-12-25", "fortnightly").map((i) => i.dueOn)).toEqual([
      "2026-12-25",
      "2027-01-08",
      "2027-01-22",
    ]);
    expect(splitInstalments(200, 2, "2026-11-01", "weekly").map((i) => i.dueOn)).toEqual([
      "2026-11-01",
      "2026-11-08",
    ]);
  });

  it("refuses impossible splits", () => {
    expect(() => splitInstalments(100, 1, "2026-10-01", "monthly")).toThrow(RangeError);
    expect(() => splitInstalments(100, 13, "2026-10-01", "monthly")).toThrow(RangeError);
    expect(() => splitInstalments(1, 2, "2026-10-01", "monthly")).toThrow(RangeError);
  });
});

describe("planProgress", () => {
  const plan = splitInstalments(90000, 3, "2026-10-15", "monthly"); // 300 each

  it("applies payments in due order and marks overdue instalments", () => {
    const p = planProgress(plan, 40000, "2026-11-20");
    expect(p.instalments.map((i) => [i.status, i.paidPesewas])).toEqual([
      ["paid", 30000],
      ["overdue", 10000],
      ["upcoming", 0],
    ]);
    expect(p).toMatchObject({ paidPesewas: 40000, remainingPesewas: 50000, overduePesewas: 20000 });
    expect(p.nextDue!.sequence).toBe(2);
  });

  it("shows part payments before the due date and finishes cleanly", () => {
    expect(planProgress(plan, 10000, "2026-10-01").instalments[0]!.status).toBe("partly_paid");
    const done = planProgress(plan, 120000, "2027-03-01");
    expect(done).toMatchObject({ paidPesewas: 90000, remainingPesewas: 0, overduePesewas: 0, nextDue: null });
    // Due today is not yet overdue.
    expect(planProgress(plan, 0, "2026-10-15").instalments[0]!.status).toBe("upcoming");
  });
});
