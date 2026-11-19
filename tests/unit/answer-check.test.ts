import { describe, expect, it } from "vitest";
import { answerFigures, containsFigure, resultFigures, uncheckedFigures } from "@/lib/answer-check";

describe("checked answers (AST-01a)", () => {
  const results = [
    {
      studentsOwing: 3,
      totalOwed: "GH₵13,906.44",
      largest: [
        { name: "Ama Mensah", class: "Basic 4A", owes: "GH₵1,000.00" },
        { name: "Kofi Owusu", class: "JHS 1", owes: "GH₵450.50" },
      ],
    },
    { term: "Term 1, 2026/2027", attendanceRate: 92.7 },
  ];

  it("finds the figures in an answer, leaving out dates, times and references", () => {
    expect(
      answerFigures("On 18 Nov 2026 at 10:30, [P1] owed GH₵1,000.00 (2026-11-01: 92.7%); Nov 3 too.").map(
        (f) => f.text,
      ),
    ).toEqual(["1,000.00", "92.7"]);
  });

  it("collects every number the tools returned, in strings too, and the length of each list", () => {
    const found = resultFigures(results);
    expect(found).toEqual(expect.arrayContaining([3, 13906.44, 1000, 450.5, 4, 1, 2026, 2027, 92.7, 2]));
  });

  it("flags only figures that are not in the results, allowing for rounding", () => {
    expect(
      uncheckedFigures(
        "Three families, 3 in all, owe GH₵13,906.44 in Term 1, 2026/2027; Ama Mensah owes GH₵1,000. Attendance is 93%.",
        results,
      ),
    ).toEqual([]);
    // Worked out by the model (the two largest added up), and invented.
    expect(
      uncheckedFigures("The two largest owe GH₵1,450.50 between them, about 12% of the total.", results),
    ).toEqual(["1,450.50", "12"]);
  });

  it("matches the figures an evaluation expects, rounded or not", () => {
    expect(containsFigure("Families owe GH₵13,906.44 today.", "GH₵13,906.44")).toBe(true);
    expect(containsFigure("Families owe about GH₵13,906 today.", "GH₵13,906.44")).toBe(true);
    expect(containsFigure("Families owe GH₵13,000 today.", "GH₵13,906.44")).toBe(false);
    expect(containsFigure("This is a forecast.", "forecast")).toBe(true);
    expect(containsFigure("Low: Chalk and Exercise books.", "Exercise books")).toBe(true);
  });
});
