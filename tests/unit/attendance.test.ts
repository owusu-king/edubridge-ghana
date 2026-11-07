import { describe, expect, it } from "vitest";
import {
  addDays,
  attendanceRate,
  decideMark,
  isIsoDate,
  isWeekend,
  nearestWeekday,
  normaliseReason,
} from "@/lib/attendance";

describe("offline register changes", () => {
  const current = { status: "present" as const, reason: null, version: 2 };

  it("applies a change made from the current version, and inserts first marks", () => {
    expect(decideMark(null, { status: "absent", reason: null, baseVersion: 0 })).toBe("insert");
    expect(decideMark(current, { status: "late", reason: null, baseVersion: 2 })).toBe("update");
  });

  it("never applies a change made from an older version: that is a conflict for a person to decide", () => {
    expect(decideMark(current, { status: "absent", reason: null, baseVersion: 1 })).toBe("conflict");
    // A change made before the mark existed, when someone else has since marked the student.
    expect(decideMark({ ...current, version: 1 }, { status: "absent", reason: null, baseVersion: 0 })).toBe(
      "conflict",
    );
  });

  it("treats a change that matches the current mark as already done (retries, or two people agreeing)", () => {
    expect(decideMark(current, { status: "present", reason: null, baseVersion: 1 })).toBe("unchanged");
    expect(
      decideMark(
        { status: "absent", reason: "Sick", version: 3 },
        { status: "absent", reason: "Sick", baseVersion: 1 },
      ),
    ).toBe("unchanged");
    expect(
      decideMark(
        { status: "absent", reason: "Sick", version: 3 },
        { status: "absent", reason: "Travel", baseVersion: 1 },
      ),
    ).toBe("conflict");
  });

  it("keeps reasons only for absences", () => {
    expect(normaliseReason("present", "Sick")).toBeNull();
    expect(normaliseReason("late", "Traffic")).toBeNull();
    expect(normaliseReason("absent", "  Sick  ")).toBe("Sick");
    expect(normaliseReason("excused", "   ")).toBeNull();
    expect(normaliseReason("absent", "x".repeat(200))).toHaveLength(120);
  });
});

describe("dates and totals", () => {
  it("works with calendar dates without time zones", () => {
    expect(addDays("2026-11-05", 1)).toBe("2026-11-06");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(isWeekend("2026-11-07")).toBe(true);
    expect(isWeekend("2026-11-09")).toBe(false);
    // Friday ↔ Monday, skipping the weekend.
    expect(nearestWeekday("2026-11-09", -1)).toBe("2026-11-06");
    expect(nearestWeekday("2026-11-06", 1)).toBe("2026-11-09");
    for (const bad of ["2026-13-01", "2026-02-30", "05/11/2026", "", null, 20261105])
      expect(isIsoDate(bad)).toBe(false);
    expect(isIsoDate("2026-11-05")).toBe(true);
  });

  it("counts late as attended", () => {
    expect(attendanceRate({ open: 0, present: 0, late: 0, absent: 0, excused: 0 })).toBeNull();
    expect(attendanceRate({ open: 20, present: 16, late: 2, absent: 1, excused: 1 })).toBe(90);
  });
});
