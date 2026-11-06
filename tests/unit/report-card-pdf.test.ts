import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReportCardSnapshot } from "@/lib/assessment";
import { DEFAULT_BANDS, DEFAULT_COMPONENTS, DEFAULT_SUBJECTS } from "@/server/assessment/defaults";
import { renderReportCardsPdf } from "@/web/pdf/report-card";

/** Set PDF_OUT to a folder to keep the rendered file for a visual check. */
const keep = (name: string, pdf: Buffer) => {
  if (process.env.PDF_OUT) writeFileSync(join(process.env.PDF_OUT, name), pdf);
};
const pageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

function card(name: string, showPositions = true): ReportCardSnapshot {
  return {
    version: 1,
    schoolName: "Kpone Ridge International School",
    term: { name: "Term 1", yearName: "2026/2027", nextTermBeginsOn: "2027-01-11" },
    student: { name, admissionNumber: "S0002", className: "Basic 4A", levelName: "Basic 4" },
    classSize: 32,
    components: DEFAULT_COMPONENTS,
    bands: DEFAULT_BANDS.primary,
    showPositions,
    subjects: DEFAULT_SUBJECTS.primary.map((subject, i) => ({
      name: subject,
      scores: i === 3 ? [410, null] : [410 + i * 5, 700 + i * 20],
      total: i === 3 ? null : 76 + i,
      grade: i === 3 ? null : "P",
      remark: i === 3 ? null : "Proficient",
      position: i === 3 ? null : i + 1,
    })),
    overall: { total: null, average: null, position: null, graded: 10 },
    attendance: { present: 58, open: 62 },
    remarks: {
      attitude: "Hardworking",
      conduct: "Respectful",
      interest: "Reading and football",
      classTeacher: "Kwame has worked steadily this term and reads with growing confidence.",
      headTeacher: "A good term. Keep it up.",
    },
    classTeacherName: "Yaw Boateng",
    approvedBy: "Comfort Adjei",
    approvedOn: "2026-12-16",
  };
}

describe("report card PDF", () => {
  it("prints one page per report card, with every subject on the page", async () => {
    const pdf = await renderReportCardsPdf([card("Kwame Mensah"), card("Akua Owusu", false)]);
    keep("report-cards.pdf", pdf);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pageCount(pdf)).toBe(2);
  });

  it("marks a draft as not approved", async () => {
    const draft = await renderReportCardsPdf(
      [{ ...card("Kwame Mensah"), approvedBy: null, approvedOn: null }],
      true,
    );
    keep("report-card-draft.pdf", draft);
    expect(pageCount(draft)).toBe(1);
  });
});
