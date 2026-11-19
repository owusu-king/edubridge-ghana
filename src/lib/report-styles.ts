/**
 * Report-card layouts. Every layout prints the same frozen results (marks, grades, remarks, attendance); they
 * differ in what each subject row shows and in the names schools use for each part. Shared by the server,
 * the PDF and the screens; framework-free.
 */
import { formatScore, weightedScore, type AssessmentComponent } from "./assessment";

export const REPORT_CARD_STYLES = ["ges", "cambridge", "ib", "american"] as const;
export type ReportCardStyle = (typeof REPORT_CARD_STYLES)[number];

export interface ReportCardStyleInfo {
  label: string;
  /** One line shown when choosing a layout. */
  description: string;
  title: string;
  /** How each subject's parts are shown: weighted towards the total, as a percentage, or as raw marks. */
  parts: "weighted" | "percent" | "raw";
  /** Whether the subject total (out of 100) is a column. */
  showTotal: boolean;
  /** Whether grade points and a GPA are shown (when the grade bands carry points). */
  showGpa: boolean;
  /** Whether class positions may be shown (only if the term also turns them on). */
  allowPositions: boolean;
  /** Whether the overall total and average are shown. */
  showAverage: boolean;
  labels: {
    attitude: string;
    conduct: string;
    interest: string;
    classTeacher: string;
    headTeacher: string;
    grade: string;
  };
}

export const REPORT_CARD_STYLE_INFO: Record<ReportCardStyle, ReportCardStyleInfo> = {
  ges: {
    label: "Terminal report (GES)",
    description:
      "Each part weighted towards a total out of 100, grade, remark and optional positions, as basic schools print them.",
    title: "Terminal report",
    parts: "weighted",
    showTotal: true,
    showGpa: false,
    allowPositions: true,
    showAverage: true,
    labels: {
      attitude: "Attitude",
      conduct: "Conduct",
      interest: "Interest",
      classTeacher: "Class teacher's remark",
      headTeacher: "Head teacher's remark",
      grade: "Grade",
    },
  },
  cambridge: {
    label: "Progress report (British and Cambridge)",
    description:
      "Each part as a percentage, overall percentage and grade, the subject teacher's comment and name. No positions.",
    title: "Progress report",
    parts: "percent",
    showTotal: true,
    showGpa: false,
    allowPositions: false,
    showAverage: true,
    labels: {
      attitude: "Attitude to learning",
      conduct: "Behaviour",
      interest: "Interests and activities",
      classTeacher: "Form tutor's comment",
      headTeacher: "Head's comment",
      grade: "Grade",
    },
  },
  ib: {
    label: "Report (IB)",
    description:
      "Each criterion's level as marked (for example 6 of 8), the final grade and its descriptor, and the teacher's comment. No totals or positions.",
    title: "Report",
    parts: "raw",
    showTotal: false,
    showGpa: false,
    allowPositions: false,
    showAverage: false,
    labels: {
      attitude: "Approaches to learning",
      conduct: "Conduct",
      interest: "Learner profile",
      classTeacher: "Homeroom teacher's comment",
      headTeacher: "Head of school's comment",
      grade: "Final grade",
    },
  },
  american: {
    label: "Report card (American)",
    description:
      "Percentage, letter grade and grade points per subject, the term GPA, and the teacher's comment. No positions.",
    title: "Report card",
    parts: "percent",
    showTotal: true,
    showGpa: true,
    allowPositions: false,
    showAverage: false,
    labels: {
      attitude: "Work habits",
      conduct: "Conduct",
      interest: "Effort",
      classTeacher: "Homeroom teacher's comment",
      headTeacher: "Principal's comment",
      grade: "Letter grade",
    },
  },
};

export function isReportCardStyle(value: unknown): value is ReportCardStyle {
  return typeof value === "string" && (REPORT_CARD_STYLES as readonly string[]).includes(value);
}

/** A grade point average held in hundredths (342 → "3.42"). */
export function formatGpa(hundredths: number): string {
  return (hundredths / 100).toFixed(2);
}

/** "3.7" or "4" → 370 or 400; null when empty; NaN when not a number from 0 to 10 with at most two decimals. */
export function parseGradePoints(input: string): number | null {
  const value = input.trim();
  if (value === "") return null;
  if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(value)) return Number.NaN;
  const hundredths = Math.round(Number(value) * 100);
  return hundredths > 1000 ? Number.NaN : hundredths;
}

/** A score as a percentage of what the part is marked out of, to a whole number (45 of 50 → "90"). */
export function percentOf(tenths: number, outOf: number): string {
  return String(Math.floor((tenths * 10) / outOf + 0.5 + 1e-9));
}

/** How one part's score is printed in a layout (— when not entered). */
export function partValue(
  tenths: number | null | undefined,
  c: AssessmentComponent,
  parts: ReportCardStyleInfo["parts"],
): string {
  if (tenths === null || tenths === undefined) return "—";
  if (parts === "weighted") return weightedScore(tenths, c);
  if (parts === "percent") return `${percentOf(tenths, c.outOf)}%`;
  return `${formatScore(tenths)}/${c.outOf}`;
}

/** A part's column heading in a layout: weighted parts say their weight. */
export function partHeader(c: AssessmentComponent, parts: ReportCardStyleInfo["parts"]): string {
  return parts === "weighted" ? `${c.name} ${c.weight}%` : c.name;
}
