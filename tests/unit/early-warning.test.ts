import { describe, expect, it } from "vitest";
import {
  absentInARow,
  attendanceLow,
  averageDown,
  subjectsBelow,
  waitingTooLong,
  windowRate,
  type Mark,
} from "@/lib/early-warning";

const marks = (statuses: string, from = "2026-11-02"): Mark[] =>
  // One register a day from `from`; P present, L late, A absent, E excused.
  [...statuses].map((c, i) => ({
    date: new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
    status: ({ P: "present", L: "late", A: "absent", E: "excused" } as const)[c as "P"],
  }));

describe("early-warning rules (EWS-01)", () => {
  it("counts attendance over a window, late as attending", () => {
    expect(windowRate(marks("PLAEP"), "2026-11-06", 28)).toMatchObject({
      open: 5,
      attended: 3,
      absent: 1,
      excused: 1,
      rate: 60,
    });
  });

  it("raises low attendance with at least five registers, from the start of the current stretch", () => {
    // Days 1–5 fine, then absences: the window first drops below 85% on day 7 (5 of 7 = 71%).
    const m = marks("PPPPPAAPP");
    const low = attendanceLow(m, "2026-11-10", 85, 28);
    expect(low).toMatchObject({ open: 9, attended: 7, rate: 78, raisedOn: "2026-11-07" });
    // Four registers are not enough to call it a pattern.
    expect(attendanceLow(marks("AAAA"), "2026-11-05", 85, 28)).toBeNull();
    expect(attendanceLow(marks("PPPPPP"), "2026-11-07", 85, 28)).toBeNull();
  });

  it("raises a run of unexplained absences up to the latest register, on the day it reached the number", () => {
    expect(absentInARow(marks("PPAAAA"), 3)).toEqual({
      dates: ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"],
      raisedOn: "2026-11-06",
    });
    // Excused days break the run (the attendance rule counts them); a run that ended does not count.
    expect(absentInARow(marks("AAEA"), 3)).toBeNull();
    expect(absentInARow(marks("AAAP"), 3)).toBeNull();
  });

  it("raises a fall in the report-card average and subjects below the pass mark", () => {
    expect(averageDown(66.5, 52, 10)).toBe(-14.5);
    expect(averageDown(60, 52, 10)).toBeNull();
    expect(averageDown(null, 40, 10)).toBeNull();
    const subjects = [
      { name: "Mathematics", total: 41 },
      { name: "Science", total: 49 },
      { name: "English Language", total: 50 },
      { name: "French", total: null },
    ];
    expect(subjectsBelow(subjects, 50, 2)).toEqual([
      { name: "Mathematics", total: 41 },
      { name: "Science", total: 49 },
    ]);
    expect(subjectsBelow(subjects, 50, 3)).toBeNull();
  });

  it("shows indicators to the Head teacher after seven days without a review", () => {
    expect(waitingTooLong("2026-11-01", "2026-11-08")).toBe(false);
    expect(waitingTooLong("2026-11-01", "2026-11-09")).toBe(true);
  });
});
