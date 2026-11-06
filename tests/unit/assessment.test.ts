import { describe, expect, it } from "vitest";
import {
  bandFor,
  bandProblems,
  bandRanges,
  classResults,
  componentProblems,
  formatScore,
  ordinal,
  parseScore,
  positions,
  subjectTotal,
  weightedScore,
  type AssessmentComponent,
} from "@/lib/assessment";
import { DEFAULT_BANDS, DEFAULT_COMPONENTS, DEFAULT_SUBJECTS } from "@/server/assessment/defaults";

const CLASS_EXAM = DEFAULT_COMPONENTS;

describe("marks", () => {
  it("parses marks with at most one decimal into tenths, and formats them back", () => {
    expect(parseScore("37.5")).toBe(375);
    expect(parseScore(" 40 ")).toBe(400);
    expect(parseScore("0")).toBe(0);
    expect(parseScore("")).toBeNull();
    for (const bad of ["37.25", "-1", "abc", "1e2", "12,5", "."]) expect(parseScore(bad)).toBeNaN();
    expect(formatScore(375)).toBe("37.5");
    expect(formatScore(400)).toBe("40");
  });

  it("totals a subject out of 100 from parts on different scales, rounding half up", () => {
    // Class score 42 of 50 (42%) + exam 75 of 100 (37.5%) = 79.5 → 80.
    expect(subjectTotal(CLASS_EXAM, { class: 420, exam: 750 })).toBe(80);
    expect(subjectTotal(CLASS_EXAM, { class: 420, exam: 740 })).toBe(79);
    expect(subjectTotal(CLASS_EXAM, { class: 500, exam: 1000 })).toBe(100);
    expect(subjectTotal(CLASS_EXAM, { class: 0, exam: 0 })).toBe(0);
    // A part not entered yet means no total.
    expect(subjectTotal(CLASS_EXAM, { class: 420 })).toBeNull();
    const thirds: AssessmentComponent[] = [
      { key: "a", name: "Test 1", weight: 30, outOf: 30 },
      { key: "b", name: "Test 2", weight: 30, outOf: 40 },
      { key: "c", name: "Exam", weight: 40, outOf: 60 },
    ];
    // 20/30*30 + 25/40*30 + 41/60*40 = 20 + 18.75 + 27.333 = 66.08 → 66
    expect(subjectTotal(thirds, { a: 200, b: 250, c: 410 })).toBe(66);
    expect(weightedScore(750, CLASS_EXAM[1]!)).toBe("37.5");
    expect(weightedScore(800, CLASS_EXAM[1]!)).toBe("40");
  });

  it("checks that parts are named, sensible and weigh 100% together", () => {
    expect(componentProblems(CLASS_EXAM)).toEqual([]);
    expect(componentProblems([{ key: "a", name: "Exam", weight: 70, outOf: 100 }])).toEqual([
      "The weights add up to 70%, not 100%.",
    ]);
    expect(componentProblems([])).toContain("Add at least one part.");
    expect(
      componentProblems([
        { key: "a", name: "Exam", weight: 50, outOf: 100 },
        { key: "b", name: "exam", weight: 50, outOf: 0 },
      ]),
    ).toEqual(['"exam" is used twice.', '"exam" must be marked out of a whole number from 1 to 1000.']);
    expect(componentProblems([{ key: "a", name: "Exam", weight: 99.5, outOf: 100 }])[0]).toMatch(
      /whole number/,
    );
  });
});

describe("grades", () => {
  it("covers every mark from 0 to 100 with the defaults", () => {
    for (const bands of Object.values(DEFAULT_BANDS)) {
      expect(bandProblems(bands)).toEqual([]);
      for (let mark = 0; mark <= 100; mark++) expect(bandFor(bands, mark)).not.toBeNull();
    }
    expect(bandFor(DEFAULT_BANDS.primary, 80)?.grade).toBe("A");
    expect(bandFor(DEFAULT_BANDS.primary, 79)?.grade).toBe("P");
    expect(bandFor(DEFAULT_BANDS.primary, 64)?.remark).toBe("Beginning");
    expect(bandFor(DEFAULT_BANDS.jhs, 90)?.grade).toBe("1");
    expect(bandFor(DEFAULT_BANDS.jhs, 34)?.grade).toBe("9");
  });

  it("rejects scales with gaps or duplicates, and lists each band's range", () => {
    expect(bandProblems([{ min: 50, grade: "P", remark: "" }])).toEqual([
      "One grade must start at 0, so every mark has a grade.",
    ]);
    expect(
      bandProblems([
        { min: 0, grade: "F", remark: "" },
        { min: 0, grade: "E", remark: "" },
      ]),
    ).toContain("Two grades start at 0.");
    expect(bandRanges(DEFAULT_BANDS.primary).map((b) => `${b.grade} ${b.range}`)).toEqual([
      "A 80–100",
      "P 75–79",
      "AP 70–74",
      "D 65–69",
      "B 0–64",
    ]);
  });

  it("lists the GES subjects for each stage", () => {
    expect(DEFAULT_SUBJECTS.jhs).toContain("Career Technology");
    expect(DEFAULT_SUBJECTS.primary).toContain("Our World Our People");
    expect(DEFAULT_SUBJECTS.kindergarten).toHaveLength(4);
  });
});

describe("class results", () => {
  it("ranks with ties sharing a position", () => {
    const ranked = positions(
      new Map([
        ["a", 80],
        ["b", 92],
        ["c", 80],
        ["d", 70],
      ]),
    );
    expect(Object.fromEntries(ranked)).toEqual({ b: 1, a: 2, c: 2, d: 4 });
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "23rd",
      "101st",
      "111th",
    ]);
  });

  it("works out totals, grades, averages and positions for a class", () => {
    const subjects = [
      { id: "eng", name: "English Language" },
      { id: "math", name: "Mathematics" },
    ];
    const scores = new Map([
      [
        "ama",
        new Map([
          ["eng", { class: 450, exam: 900 }], // 45 + 45 = 90
          ["math", { class: 400, exam: 800 }], // 40 + 40 = 80
        ]),
      ],
      [
        "kofi",
        new Map([
          ["eng", { class: 450, exam: 900 }], // 90
          ["math", { class: 300, exam: 600 }], // 60
        ]),
      ],
      ["yaw", new Map([["eng", { class: 250 }]])], // incomplete everywhere
    ]);
    const results = classResults({
      components: CLASS_EXAM,
      bands: DEFAULT_BANDS.primary,
      subjects,
      studentIds: ["ama", "kofi", "yaw"],
      scores,
    });
    const ama = results.get("ama")!;
    expect(ama.subjects.map((s) => [s.total, s.grade, s.position])).toEqual([
      [90, "A", 1],
      [80, "A", 1],
    ]);
    expect([ama.total, ama.average, ama.position, ama.graded]).toEqual([170, 85, 1, 2]);
    const kofi = results.get("kofi")!;
    expect(kofi.subjects[0]!.position).toBe(1); // tied with Ama in English
    expect(kofi.subjects[1]).toMatchObject({ total: 60, grade: "B", remark: "Beginning", position: 2 });
    expect([kofi.total, kofi.average, kofi.position]).toEqual([150, 75, 2]);
    const yaw = results.get("yaw")!;
    expect(yaw.subjects[0]).toMatchObject({ scores: [250, null], total: null, grade: null, position: null });
    expect([yaw.total, yaw.average, yaw.position, yaw.graded]).toEqual([null, null, null, 0]);
  });
});
