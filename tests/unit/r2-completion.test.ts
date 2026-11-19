import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bandProblems,
  classResults,
  componentProblems,
  gradePointAverage,
  type GradeBand,
  type ReportCardSnapshot,
} from "@/lib/assessment";
import { CURRICULUM_TEMPLATES, curriculumTemplate, STAGES } from "@/lib/curricula";
import {
  formatGpa,
  parseGradePoints,
  partHeader,
  partValue,
  percentOf,
  REPORT_CARD_STYLES,
} from "@/lib/report-styles";
import { isoWeekday, normaliseTime, overlappingPeriod, sortPeriods } from "@/lib/timetable";
import { renderReportCardsPdf } from "@/web/pdf/report-card";

const keep = (name: string, pdf: Buffer) => {
  if (process.env.PDF_OUT) writeFileSync(join(process.env.PDF_OUT, name), pdf);
};
const pageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

describe("timetable arithmetic", () => {
  it("knows the weekday of a date", () => {
    expect(isoWeekday("2026-11-09")).toBe(1); // a Monday
    expect(isoWeekday("2026-11-13")).toBe(5);
    expect(isoWeekday("2026-11-15")).toBe(7);
  });

  it("reads times of day", () => {
    expect(normaliseTime("8:05")).toBe("08:05");
    expect(normaliseTime(" 13:40 ")).toBe("13:40");
    expect(normaliseTime("24:00")).toBeNull();
    expect(normaliseTime("8.05")).toBeNull();
  });

  it("finds overlapping periods but lets one end where the next starts", () => {
    const day = [
      { id: "a", name: "Period 1", startsAt: "08:00", endsAt: "08:40" },
      { id: "b", name: "Period 2", startsAt: "08:40", endsAt: "09:20" },
    ];
    expect(overlappingPeriod({ name: "Break", startsAt: "09:20", endsAt: "09:40" }, day)).toBeNull();
    expect(overlappingPeriod({ name: "X", startsAt: "08:30", endsAt: "08:50" }, day)?.id).toBe("a");
    // A period does not clash with itself when its times are changed.
    expect(
      overlappingPeriod({ id: "a", name: "Period 1", startsAt: "07:50", endsAt: "08:40" }, day),
    ).toBeNull();
    expect(sortPeriods([day[1]!, day[0]!]).map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("grade points and GPA", () => {
  const bands: GradeBand[] = [
    { min: 90, grade: "A", remark: "", points: 400 },
    { min: 80, grade: "B", remark: "", points: 300 },
    { min: 0, grade: "F", remark: "", points: 0 },
  ];

  it("parses grade points to hundredths", () => {
    expect(parseGradePoints("3.7")).toBe(370);
    expect(parseGradePoints("4")).toBe(400);
    expect(parseGradePoints("")).toBeNull();
    expect(parseGradePoints("10.5")).toBeNaN();
    expect(parseGradePoints("abc")).toBeNaN();
    expect(formatGpa(342)).toBe("3.42");
  });

  it("averages the points of graded subjects, half up", () => {
    expect(gradePointAverage([{ total: 95 }, { total: 85 }, { total: null }], bands)).toBe(350);
    expect(gradePointAverage([{ total: 95 }, { total: 85 }, { total: 85 }], bands)).toBe(333);
    expect(gradePointAverage([{ total: null }], bands)).toBeNull();
  });

  it("has no GPA when a grade carries no points", () => {
    const mixed: GradeBand[] = [{ min: 50, grade: "P", remark: "" }, ...bands.slice(2)];
    expect(gradePointAverage([{ total: 60 }], mixed)).toBeNull();
  });

  it("works the GPA out with class results", () => {
    const results = classResults({
      components: [{ key: "exam", name: "Exam", weight: 100, outOf: 100 }],
      bands,
      subjects: [
        { id: "m", name: "Maths" },
        { id: "e", name: "English" },
      ],
      studentIds: ["s"],
      scores: new Map([
        [
          "s",
          new Map([
            ["m", { exam: 950 }],
            ["e", { exam: 820 }],
          ]),
        ],
      ]),
    });
    expect(results.get("s")!.gpa).toBe(350);
  });

  it("refuses grade points out of range", () => {
    expect(bandProblems([{ min: 0, grade: "A", remark: "", points: 1200 }])[0]).toMatch(/Grade points/);
    expect(bandProblems([{ min: 0, grade: "A", remark: "", points: 370 }])).toEqual([]);
  });
});

describe("curriculum templates", () => {
  it("are all usable: parts add up to 100% and every stage's grades cover 0 to 100", () => {
    for (const t of CURRICULUM_TEMPLATES) {
      expect(componentProblems(t.components), t.id).toEqual([]);
      for (const stage of STAGES) expect(bandProblems(t.bands[stage]), `${t.id} ${stage}`).toEqual([]);
      expect(REPORT_CARD_STYLES).toContain(t.reportStyle);
      expect(t.id).toMatch(/^[a-z_]{2,40}$/);
    }
  });

  it("include IB (criteria out of 8, 1–7) and American (letter grades with points)", () => {
    const ib = curriculumTemplate("ib", "GH");
    expect(ib.components.map((c) => c.outOf)).toEqual([8, 8, 8, 8]);
    // IB boundaries: 28 of 32 is a 7, 27 of 32 a 6 (percentages rounded half up as totals are).
    const total = (raw: number) => Math.floor((raw * 100) / 32 + 0.5);
    const grade = (raw: number) => ib.bands.jhs.find((b) => total(raw) >= b.min)!.grade;
    expect([grade(28), grade(27), grade(24), grade(23), grade(19), grade(18), grade(5)]).toEqual([
      "7",
      "6",
      "6",
      "5",
      "5",
      "4",
      "1",
    ]);
    const us = curriculumTemplate("american", "GH");
    expect(us.reportStyle).toBe("american");
    expect(us.bands.primary.every((b) => typeof b.points === "number")).toBe(true);
  });
});

describe("report-card layouts", () => {
  const exam = { key: "exam", name: "Exam", weight: 60, outOf: 50 };
  it("print a part weighted, as a percentage, or as marked", () => {
    expect(partValue(450, exam, "weighted")).toBe("54");
    expect(partValue(450, exam, "percent")).toBe("90%");
    expect(partValue(65, { ...exam, outOf: 8 }, "raw")).toBe("6.5/8");
    expect(partValue(null, exam, "raw")).toBe("—");
    expect(partHeader(exam, "weighted")).toBe("Exam 60%");
    expect(partHeader(exam, "raw")).toBe("Exam");
    expect(percentOf(375, 50)).toBe("75");
  });

  function card(style: ReportCardSnapshot["style"]): ReportCardSnapshot {
    const us = curriculumTemplate("american", "GH");
    return {
      version: 1,
      schoolName: "Kpone Ridge International School",
      term: { name: "Term 1", yearName: "2026/2027", nextTermBeginsOn: "2027-01-11" },
      student: { name: "Ama Owusu", admissionNumber: "S0002", className: "Grade 4A", levelName: "Grade 4" },
      classSize: 24,
      components: us.components,
      bands: us.bands.primary,
      showPositions: true,
      subjects: us.subjects.primary.map((name, i) => ({
        name,
        scores: [800 + i * 10, 850],
        total: 84 + i,
        grade: "B",
        remark: "Good",
        position: i + 1,
        // A comment on every subject (the longest card) still fits on one page.
        comment:
          "Ama reads widely and explains her reasoning clearly; next, she should check her working before handing in.",
        teacher: "Kofi Asante",
      })),
      overall: { total: 700, average: 87.5, position: 3, graded: 8, gpa: 312 },
      attendance: { present: 58, open: 62 },
      remarks: {
        attitude: "Organised",
        conduct: "Respectful",
        interest: "Science club",
        classTeacher: "A steady term with real progress in writing.",
        headTeacher: "Well done.",
      },
      classTeacherName: "Yaw Boateng",
      approvedBy: "Comfort Adjei",
      approvedOn: "2026-12-16",
      ...(style ? { style } : {}),
    };
  }

  it("render one page per card in every layout, and earlier cards without a layout as GES", async () => {
    for (const style of [...REPORT_CARD_STYLES, undefined]) {
      const pdf = await renderReportCardsPdf([card(style), card(style)]);
      keep(`report-card-${style ?? "earlier"}.pdf`, pdf);
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pageCount(pdf), style).toBe(2);
    }
  });
});
