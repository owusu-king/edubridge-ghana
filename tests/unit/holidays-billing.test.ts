import { describe, expect, it } from "vitest";
import { absenceRun } from "@/server/attendance/alerts";
import { absenceAlertSms } from "@/lib/fee-messages";
import { easterSunday, farmersDay, ghanaPublicHolidays } from "@/lib/holidays";
import { billingState } from "@/lib/plan";

describe("Ghana's public holidays", () => {
  it("works out Easter and Farmers' Day", () => {
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    expect(easterSunday(2024)).toBe("2024-03-31");
    expect(farmersDay(2026)).toBe("2026-12-04");
    expect(farmersDay(2027)).toBe("2027-12-03");
  });

  it("lists a school year's holidays in order, with the 2025 changes", () => {
    const year = ghanaPublicHolidays("2026-09-08", "2027-07-30");
    expect(year.map((h) => `${h.date} ${h.name}`)).toEqual([
      "2026-09-21 Founders' Day",
      "2026-12-04 Farmers' Day",
      "2026-12-25 Christmas Day",
      "2026-12-26 Boxing Day",
      "2027-01-01 New Year's Day",
      "2027-01-07 Constitution Day",
      "2027-03-06 Independence Day",
      "2027-03-26 Good Friday",
      "2027-03-29 Easter Monday",
      "2027-05-01 May Day",
      "2027-07-01 Republic Day",
    ]);
    // 4 August is no longer a holiday.
    expect(ghanaPublicHolidays("2027-08-01", "2027-08-31")).toEqual([]);
  });
});

describe("overdue EduBridge invoices", () => {
  const base = { manualStatus: "active" as const, today: "2026-11-10", graceDays: 3 };

  it("gives grace days after the due date, then pauses SMS", () => {
    expect(billingState({ ...base, unpaidDueDates: [] })).toEqual({
      state: "ok",
      overdueSince: null,
      graceEndsOn: null,
    });
    // Due today is not overdue yet.
    expect(billingState({ ...base, unpaidDueDates: ["2026-11-10"] }).state).toBe("ok");
    expect(billingState({ ...base, unpaidDueDates: ["2026-11-09"] })).toEqual({
      state: "grace",
      overdueSince: "2026-11-09",
      graceEndsOn: "2026-11-12",
    });
    // The last grace day still counts as grace; the day after, SMS pause.
    expect(billingState({ ...base, unpaidDueDates: ["2026-11-07"] }).state).toBe("grace");
    expect(billingState({ ...base, unpaidDueDates: ["2026-11-06"] }).state).toBe("limited");
    // The oldest overdue invoice decides.
    expect(billingState({ ...base, unpaidDueDates: ["2026-11-09", "2026-10-01"] }).overdueSince).toBe(
      "2026-10-01",
    );
  });

  it("pauses at once when platform staff set the status to payment overdue", () => {
    expect(billingState({ ...base, manualStatus: "past_due", unpaidDueDates: [] }).state).toBe("limited");
    expect(billingState({ ...base, graceDays: 0, unpaidDueDates: ["2026-11-09"] }).state).toBe("limited");
  });
});

describe("absence SMS", () => {
  it("counts the latest run of absences, ignoring excused days and stopping at a day present", () => {
    expect(
      absenceRun([
        { date: "2026-11-06", status: "absent" },
        { date: "2026-11-05", status: "absent" },
        { date: "2026-11-04", status: "absent" },
        { date: "2026-11-03", status: "present" },
        { date: "2026-11-02", status: "absent" },
      ]),
    ).toEqual({ days: 3, startsOn: "2026-11-04" });
    expect(absenceRun([{ date: "2026-11-06", status: "excused" }])).toEqual({ days: 0, startsOn: null });
    expect(absenceRun([])).toEqual({ days: 0, startsOn: null });
  });

  it("says how many days, never why, in one SMS", () => {
    const text = absenceAlertSms({
      schoolName: "Kpone Ridge International School",
      studentFirstName: "Ama",
      days: 3,
      kind: "consecutive",
    });
    expect(text).toBe(
      "Kpone Ridge International School: Ama has been absent for 3 school days in a row. Please contact the school.",
    );
    expect(text.length).toBeLessThanOrEqual(160);
    expect(
      absenceAlertSms({ schoolName: "Adenta", studentFirstName: "Kofi", days: 10, kind: "term_total" }),
    ).toBe("Adenta: Kofi has been absent for 10 school days this term. Please contact the school.");
  });
});
