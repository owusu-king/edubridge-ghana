import { describe, expect, it } from "vitest";
import {
  backtestLastTerm,
  collectedBy,
  dayOfTerm,
  expectedBetween,
  forecastTerm,
  median,
  shareBy,
  type TermHistory,
} from "@/lib/forecast";

/** A 28-day term (Monday 5 Jan to Sunday 1 Feb 2026) that billed 1,000.00 and collected on the given days. */
const term = (id: string, startsOn: string, endsOn: string, days: [string, number][], billed = 100_000) =>
  ({
    termId: id,
    label: id,
    startsOn,
    endsOn,
    billedPesewas: billed,
    days: days.map(([date, totalPesewas]) => ({ date, totalPesewas })),
  }) satisfies TermHistory;

// Two past terms: A collects half in week 1 and the rest by the end; B collects a quarter, then three quarters.
const A = term("A", "2025-01-06", "2025-02-02", [
  ["2025-01-06", 50_000],
  ["2025-01-20", 50_000],
]);
const B = term("B", "2025-04-07", "2025-05-04", [
  ["2025-04-07", 25_000],
  ["2025-04-28", 50_000],
]);

describe("collection forecasting (FCT-01)", () => {
  it("counts days of term and the share collected by each day", () => {
    expect(dayOfTerm("2025-01-06", "2025-01-06")).toBe(1);
    expect(dayOfTerm("2025-01-06", "2025-01-05")).toBe(0);
    expect(collectedBy(A, 7)).toBe(50_000);
    expect(collectedBy(A, 100)).toBe(100_000);
    expect(shareBy(B, 28)).toBe(0.75);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("expects the past terms' further share of this term's billed fees: median likely, lowest and highest the range", () => {
    // From day 7 to the end: A went on to collect 0.5 more, B 0.5 more.
    expect(expectedBetween([A, B], 200_000, 7, 28)).toEqual({
      likelyPesewas: 100_000,
      lowPesewas: 100_000,
      highPesewas: 100_000,
    });
    // From day 0 to day 7: A 0.5, B 0.25.
    expect(expectedBetween([A, B], 200_000, 0, 7)).toEqual({
      likelyPesewas: 75_000,
      lowPesewas: 50_000,
      highPesewas: 100_000,
    });
  });

  it("forecasts the rest of the term by week from what has been collected, with plan instalments beside it", () => {
    const now = term("C", "2026-01-05", "2026-02-01", [["2026-01-06", 40_000]], 200_000);
    const f = forecastTerm(now, [A, B], "2026-01-11", [
      { date: "2026-01-20", totalPesewas: 5_000 },
      { date: "2026-01-08", totalPesewas: 9_999 }, // already past: not shown
    ]);
    if (f.status !== "forecast") throw new Error(f.status);
    expect(f.collectedPesewas).toBe(40_000);
    expect(f.basedOn.map((t) => t.termId)).toEqual(["A", "B"]);
    expect(f.weeks).toHaveLength(4);
    expect(f.weeks[0]).toMatchObject({
      from: "2026-01-05",
      to: "2026-01-11",
      actualPesewas: 40_000,
      expected: null,
    });
    expect(f.weeks[1]).toMatchObject({ actualPesewas: null, instalmentsPesewas: 0 });
    expect(f.weeks[2]).toMatchObject({ from: "2026-01-19", instalmentsPesewas: 5_000 });
    // Each past term went on to collect half its fees after day 7: 100,000 more is likely.
    expect(f.endOfTerm).toEqual({ likelyPesewas: 140_000, lowPesewas: 140_000, highPesewas: 140_000 });
    // The weeks add up to the end of term.
    const sum = (k: "likelyPesewas" | "lowPesewas" | "highPesewas") =>
      f.weeks.reduce((s, w) => s + (w.expected?.[k] ?? 0), 0);
    expect(f.collectedPesewas + sum("likelyPesewas")).toBe(f.endOfTerm.likelyPesewas);
    expect(f.collectedPesewas + sum("highPesewas")).toBe(f.endOfTerm.highPesewas);
  });

  it("says when there is not enough history, nothing billed, or the term has ended", () => {
    const now = term("C", "2026-01-05", "2026-02-01", [], 200_000);
    expect(forecastTerm(now, [], "2026-01-11").status).toBe("no_history");
    // A past term that billed nothing, or one not yet over, does not count.
    const unbilled = term("D", "2025-09-01", "2025-12-12", [], 0);
    const unfinished = term("E", "2025-12-01", "2026-03-01", []);
    expect(forecastTerm(now, [unbilled, unfinished], "2026-01-11").status).toBe("no_history");
    expect(forecastTerm({ ...now, billedPesewas: 0 }, [A], "2026-01-11").status).toBe("not_billed");
    expect(forecastTerm(now, [A], "2026-03-01")).toEqual({
      status: "ended",
      collectedPesewas: 0,
      billedPesewas: 200_000,
    });
  });

  it("checks last term's forecast at the same day against what it collected", () => {
    // B, forecast at day 7 from A: 25,000 collected + 0.5 × 100,000 = 75,000; B collected 75,000.
    expect(backtestLastTerm([A, B], "2026-01-11", 7)).toEqual({
      termId: "B",
      label: "B",
      day: 7,
      forecastPesewas: 75_000,
      collectedPesewas: 75_000,
      errorPercent: 0,
    });
    // With only one past term, last term had nothing to learn from.
    expect(backtestLastTerm([B], "2026-01-11", 7)).toBeNull();
  });
});
