import { describe, expect, it } from "vitest";
import {
  ageOwed,
  axisCedis,
  daysBetween,
  niceTicks,
  percent,
  reminderOutcome,
  weeklyTotals,
  weekStart,
} from "@/lib/dashboard";
import { setupState, type SetupCounts } from "@/lib/setup";

const TODAY = "2026-11-06";
const daysBefore = (days: number) =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

describe("how old what is owed is", () => {
  it("settles the oldest charges first, so what is left is the newest", () => {
    const lines = [
      { amountPesewas: 50_000, effectiveOn: "2026-07-24" }, // brought forward: 105 days
      { amountPesewas: 100_000, effectiveOn: "2026-09-08" }, // this term's fees: 59 days
      { amountPesewas: -80_000, effectiveOn: "2026-10-01" }, // a payment
      { amountPesewas: 5_000, effectiveOn: "2026-10-20" }, // a one-off charge: 17 days
    ];
    // The payment clears the brought-forward GH₵500 and GH₵300 of the term's fees.
    expect(ageOwed(lines, TODAY)).toEqual([5_000, 70_000, 0, 0]);
  });

  it("adds up to the balance when owed, and to nothing when in credit", () => {
    const owed = [
      { amountPesewas: 30_000, effectiveOn: "2026-01-10" },
      { amountPesewas: 20_000, effectiveOn: "2026-08-20" },
      { amountPesewas: -10_000, effectiveOn: "2026-09-01" },
    ];
    expect(ageOwed(owed, TODAY)).toEqual([0, 0, 20_000, 20_000]);
    expect(ageOwed(owed, TODAY).reduce((a, b) => a + b, 0)).toBe(40_000);
    const credit = [
      { amountPesewas: 30_000, effectiveOn: "2026-09-08" },
      { amountPesewas: -45_000, effectiveOn: "2026-09-01" },
    ];
    expect(ageOwed(credit, TODAY)).toEqual([0, 0, 0, 0]);
  });

  it("applies a payment made ahead of a charge to that charge", () => {
    const lines = [
      { amountPesewas: -20_000, effectiveOn: "2026-08-01" },
      { amountPesewas: 50_000, effectiveOn: "2026-09-08" },
    ];
    expect(ageOwed(lines, TODAY)).toEqual([0, 30_000, 0, 0]);
  });

  it("counts charges dated ahead (a term billed early) as new", () => {
    expect(ageOwed([{ amountPesewas: 10_000, effectiveOn: "2027-01-12" }], TODAY)).toEqual([10_000, 0, 0, 0]);
  });

  it("puts each boundary day in the younger group", () => {
    const at = (days: number) => ageOwed([{ amountPesewas: 1, effectiveOn: daysBefore(days) }], TODAY);
    expect(at(30)).toEqual([1, 0, 0, 0]);
    expect(at(31)).toEqual([0, 1, 0, 0]);
    expect(at(90)).toEqual([0, 0, 1, 0]);
    expect(at(91)).toEqual([0, 0, 0, 1]);
  });
});

describe("weeks, rates and axes", () => {
  it("works with calendar dates", () => {
    expect(daysBetween("2026-09-08", TODAY)).toBe(59);
    expect(weekStart("2026-11-06")).toBe("2026-11-02"); // Friday to its Monday
    expect(weekStart("2026-11-08")).toBe("2026-11-02"); // Sunday to its Monday
    expect(weekStart("2026-11-09")).toBe("2026-11-09");
  });

  it("gathers days into Monday-to-Sunday weeks clipped to the period, keeping empty weeks", () => {
    const weeks = weeklyTotals(
      [
        { date: "2026-09-08", totalPesewas: 100 },
        { date: "2026-09-13", totalPesewas: 50 },
        { date: "2026-09-29", totalPesewas: 25 },
      ],
      "2026-09-08",
      "2026-09-30",
    );
    expect(weeks).toEqual([
      { from: "2026-09-08", to: "2026-09-13", totalPesewas: 150 },
      { from: "2026-09-14", to: "2026-09-20", totalPesewas: 0 },
      { from: "2026-09-21", to: "2026-09-27", totalPesewas: 0 },
      { from: "2026-09-28", to: "2026-09-30", totalPesewas: 25 },
    ]);
    expect(weeklyTotals([], "2026-09-30", "2026-09-01")).toEqual([]);
  });

  it("gives whole percentages, and none when there is nothing to divide by", () => {
    expect(percent(335_656, 494_705)).toBe(68);
    expect(percent(5, 0)).toBeNull();
    expect(percent(0, 10)).toBe(0);
  });

  it("chooses clean axis ticks in cedis and labels each axis in one style", () => {
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(9_632_100)).toEqual([0, 2_500_000, 5_000_000, 7_500_000, 10_000_000]);
    expect(niceTicks(170_000)).toEqual([0, 50_000, 100_000, 150_000, 200_000]);
    expect(axisCedis(150_000, false)).toBe("GH₵1,500");
    expect(axisCedis(2_500_000, true)).toBe("GH₵25K");
    expect(axisCedis(0, true)).toBe("GH₵0");
    expect(axisCedis(150_000_000, true)).toBe("GH₵1.5M");
  });
});

describe("what happened after reminders", () => {
  it("counts students who paid within a week of a reminder, and each payment once", () => {
    const outcome = reminderOutcome(
      [
        { studentId: "a", sentOn: "2026-10-01" },
        { studentId: "a", sentOn: "2026-10-05" },
        { studentId: "b", sentOn: "2026-10-01" },
        { studentId: "c", sentOn: "2026-10-01" },
      ],
      [
        { id: "p1", studentId: "a", paidOn: "2026-10-06", amountPesewas: 10_000 }, // after both of a's reminders
        { id: "p2", studentId: "b", paidOn: "2026-10-08", amountPesewas: 5_000 }, // the 7th day still counts
        { id: "p3", studentId: "c", paidOn: "2026-10-09", amountPesewas: 7_000 }, // too late
        { id: "p4", studentId: "c", paidOn: "2026-09-30", amountPesewas: 7_000 }, // before the reminder
      ],
    );
    expect(outcome).toEqual({ reminded: 3, paid: 2, paidPesewas: 15_000 });
  });
});

describe("setup guide", () => {
  const empty: SetupCounts = {
    currentTerm: null,
    years: 0,
    levels: 0,
    classes: 0,
    classesWithTeacher: 0,
    staff: 0,
    activeStudents: 0,
    placedStudents: 0,
    placedWithPhone: 0,
    feeItems: 0,
    feeLines: 0,
    billedStudents: 0,
    levelsInUse: 0,
    levelsInUseWithSubjects: 0,
  };
  const statuses = (c: SetupCounts) =>
    Object.fromEntries(Object.entries(setupState(c)).map(([step, state]) => [step, state.status]));

  it("starts with everything to do", () => {
    expect(new Set(Object.values(statuses(empty)))).toEqual(new Set(["todo"]));
  });

  it("marks steps started when partly done, and done only when the records show it", () => {
    const partly: SetupCounts = {
      ...empty,
      years: 1,
      levels: 6,
      classes: 2,
      classesWithTeacher: 1,
      levelsInUse: 1,
      activeStudents: 10,
      feeItems: 2,
    };
    expect(statuses(partly)).toEqual({
      calendar: "started",
      classes: "done",
      teachers: "started",
      students: "started",
      guardians: "todo",
      fees: "started",
      assessment: "todo",
    });
    expect(setupState(partly).students.detail).toBe(
      "10 students added. Set the current term to place them in classes.",
    );
    expect(setupState(partly).teachers.detail).toBe("1 of 2 classes have a class teacher.");
  });

  it("is complete only when every step is done", () => {
    const done: SetupCounts = {
      currentTerm: "Term 1, 2026/2027",
      years: 1,
      levels: 6,
      classes: 2,
      classesWithTeacher: 2,
      staff: 3,
      activeStudents: 40,
      placedStudents: 40,
      placedWithPhone: 40,
      feeItems: 3,
      feeLines: 6,
      billedStudents: 40,
      levelsInUse: 1,
      levelsInUseWithSubjects: 1,
    };
    expect(new Set(Object.values(statuses(done)))).toEqual(new Set(["done"]));
    // One student still to bill re-opens the fees step.
    expect(setupState({ ...done, billedStudents: 39 }).fees).toEqual({
      status: "started",
      detail: "Fees are set. 39 of 40 students billed this term.",
    });
  });
});
