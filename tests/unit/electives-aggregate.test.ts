import { describe, expect, it } from "vitest";
import { beceAggregate, classResults, type AssessmentComponent } from "@/lib/assessment";
import { curriculumTemplate } from "@/lib/curricula";

const grade = (name: string, g: string | null) => ({ name, grade: g });

describe("BECE-style aggregate", () => {
  it("adds the four core grades and the best two others", () => {
    expect(
      beceAggregate([
        grade("English Language", "2"),
        grade("Mathematics", "1"),
        grade("Science", "3"),
        grade("Social Studies", "2"),
        grade("French", "6"),
        grade("Computing", "1"),
        grade("Religious and Moral Education", "2"),
      ]),
    ).toBe(2 + 1 + 3 + 2 + 1 + 2);
  });

  it("is 6 at best and needs every core subject and two others graded", () => {
    const core = ["English Language", "Mathematics", "Science", "Social Studies"].map((n) => grade(n, "1"));
    expect(beceAggregate([...core, grade("ICT", "1"), grade("French", "1")])).toBe(6);
    expect(beceAggregate([...core, grade("ICT", "1")])).toBeNull();
    expect(
      beceAggregate([...core.slice(1), grade("ICT", "1"), grade("French", "1"), grade("Art", "1")]),
    ).toBeNull();
    expect(
      beceAggregate([
        ...core.slice(0, 3),
        grade("Social Studies", null),
        grade("ICT", "1"),
        grade("Art", "1"),
      ]),
    ).toBeNull();
    // Grades that are not on the 1–9 scale give no aggregate.
    expect(
      beceAggregate([
        ...core.slice(0, 3),
        grade("Social Studies", "A"),
        grade("ICT", "1"),
        grade("Art", "1"),
      ]),
    ).toBeNull();
  });
});

describe("elective subjects in class results", () => {
  const components: AssessmentComponent[] = [{ key: "exam", name: "Exam", weight: 100, outOf: 100 }];
  const bands = curriculumTemplate("ghana_ges", "GH").bands.shs;
  const subjects = [
    { id: "eng", name: "English Language" },
    { id: "phy", name: "Physics" },
    { id: "eco", name: "Economics" },
  ];
  const scores = new Map([
    [
      "ama",
      new Map([
        ["eng", { exam: 800 }],
        ["phy", { exam: 700 }],
      ]),
    ],
    [
      "kofi",
      new Map([
        ["eng", { exam: 600 }],
        ["eco", { exam: 900 }],
      ]),
    ],
  ]);

  it("counts only the subjects each student takes, and ranks an elective among its takers", () => {
    const results = classResults({
      components,
      bands,
      subjects,
      studentIds: ["ama", "kofi"],
      scores,
      electives: new Set(["phy", "eco"]),
      choices: new Map([
        ["ama", new Set(["phy"])],
        ["kofi", new Set(["eco"])],
      ]),
    });
    const ama = results.get("ama")!;
    expect(ama.subjects.map((s) => s.name)).toEqual(["English Language", "Physics"]);
    expect(ama).toMatchObject({ total: 150, average: 75, graded: 2 });
    expect(ama.subjects[0]!.grade).toBe("A1");
    expect(ama.subjects[1]!).toMatchObject({ grade: "B2", position: 1 });
    expect(results.get("kofi")!).toMatchObject({ total: 150, average: 75 });
  });

  it("gives SHS the WASSCE grades A1 to F9", () => {
    expect(bands.map((b) => b.grade)).toEqual(["A1", "B2", "B3", "C4", "C5", "C6", "D7", "E8", "F9"]);
  });
});
