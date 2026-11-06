/**
 * Assessment arithmetic: components and weights, grade bands, subject totals, class positions. Pure and
 * framework-free, shared by the server (report cards, PDFs) and the score sheet (live totals).
 *
 * Scores are held as integer tenths of a mark (37.5 → 375), so sums never drift. A subject total is the sum
 * of each component's score scaled to its weight, out of 100, rounded half up to a whole mark; the grade is
 * read from that whole mark. A subject without every component scored has no total and no grade.
 */

export interface AssessmentComponent {
  /** Stable key that scores refer to; names and weights can change, the key does not. */
  key: string;
  name: string;
  /** Share of the subject total, in percent. The weights of a scheme add up to 100. */
  weight: number;
  /** What the score is entered out of, e.g. an exam marked out of 100 that counts for 50%. */
  outOf: number;
}

export interface GradeBand {
  /** Lowest whole mark (0–100) that earns this grade. */
  min: number;
  grade: string;
  remark: string;
}

export const MAX_COMPONENTS = 6;
export const MAX_BANDS = 12;

/** Problems with a set of components, or an empty list when it is usable. */
export function componentProblems(components: readonly AssessmentComponent[]): string[] {
  const problems: string[] = [];
  if (components.length === 0) problems.push("Add at least one part.");
  if (components.length > MAX_COMPONENTS) problems.push(`Use ${MAX_COMPONENTS} parts or fewer.`);
  const names = new Set<string>();
  for (const c of components) {
    if (!c.name.trim()) problems.push("Give every part a name.");
    if (names.has(c.name.trim().toLowerCase())) problems.push(`"${c.name}" is used twice.`);
    names.add(c.name.trim().toLowerCase());
    if (!Number.isInteger(c.weight) || c.weight < 1 || c.weight > 100)
      problems.push(`The weight of "${c.name}" must be a whole number from 1 to 100.`);
    if (!Number.isInteger(c.outOf) || c.outOf < 1 || c.outOf > 1000)
      problems.push(`"${c.name}" must be marked out of a whole number from 1 to 1000.`);
  }
  const total = components.reduce((sum, c) => sum + c.weight, 0);
  if (components.length > 0 && total !== 100) problems.push(`The weights add up to ${total}%, not 100%.`);
  return [...new Set(problems)];
}

/** Problems with a grading scale, or an empty list when every whole mark from 0 to 100 has one grade. */
export function bandProblems(bands: readonly GradeBand[]): string[] {
  const problems: string[] = [];
  if (bands.length === 0) problems.push("Add at least one grade.");
  if (bands.length > MAX_BANDS) problems.push(`Use ${MAX_BANDS} grades or fewer.`);
  const mins = new Set<number>();
  for (const b of bands) {
    if (!b.grade.trim()) problems.push("Give every band a grade.");
    if (!Number.isInteger(b.min) || b.min < 0 || b.min > 100)
      problems.push(`Lowest marks must be whole numbers from 0 to 100 (grade ${b.grade}).`);
    if (mins.has(b.min)) problems.push(`Two grades start at ${b.min}.`);
    mins.add(b.min);
  }
  if (bands.length > 0 && !mins.has(0))
    problems.push("One grade must start at 0, so every mark has a grade.");
  return [...new Set(problems)];
}

/** Bands from the highest to the lowest. */
export function sortBands(bands: readonly GradeBand[]): GradeBand[] {
  return [...bands].sort((a, b) => b.min - a.min);
}

/** The band a whole mark falls in. */
export function bandFor(bands: readonly GradeBand[], mark: number): GradeBand | null {
  return sortBands(bands).find((b) => mark >= b.min) ?? null;
}

/** "37.5" → 375. Null for an empty entry; NaN for anything that is not a mark with at most one decimal. */
export function parseScore(input: string): number | null {
  const value = input.trim();
  if (value === "") return null;
  if (!/^\d{1,4}(?:\.\d)?$/.test(value)) return Number.NaN;
  return Math.round(Number(value) * 10);
}

/** 375 → "37.5"; 400 → "40". */
export function formatScore(tenths: number): string {
  return tenths % 10 === 0 ? String(tenths / 10) : (tenths / 10).toFixed(1);
}

/** A score as it counts towards the total, to one decimal: 75 out of 100 in a 50% exam → "37.5". */
export function weightedScore(tenths: number, component: AssessmentComponent): string {
  const value = Math.round((tenths * component.weight) / component.outOf) / 10;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Each band with the marks it covers, highest first: "80–100", "75–79", … */
export function bandRanges(bands: readonly GradeBand[]): (GradeBand & { range: string })[] {
  const sorted = sortBands(bands);
  return sorted.map((b, i) => {
    const top = i === 0 ? 100 : sorted[i - 1]!.min - 1;
    return { ...b, range: top <= b.min ? String(b.min) : `${b.min}–${top}` };
  });
}

/** The subject total out of 100, or null unless every component is scored. */
export function subjectTotal(
  components: readonly AssessmentComponent[],
  scores: Readonly<Record<string, number | null | undefined>>,
): number | null {
  let total = 0;
  for (const c of components) {
    const tenths = scores[c.key];
    if (tenths === null || tenths === undefined) return null;
    total += (tenths * c.weight) / (10 * c.outOf);
  }
  // Half up; the small allowance absorbs binary error in values such as 79.5.
  return Math.floor(total + 0.5 + 1e-9);
}

/** Competition ranking: equal values share a position and the next is skipped (1, 2, 2, 4). */
export function positions(values: ReadonlyMap<string, number>): Map<string, number> {
  const sorted = [...values.values()].sort((a, b) => b - a);
  const result = new Map<string, number>();
  for (const [id, value] of values) result.set(id, sorted.indexOf(value) + 1);
  return result;
}

/** 1 → "1st", 12 → "12th", 22 → "22nd". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

export interface SubjectResult {
  subjectId: string;
  name: string;
  /** Scores in tenths, in component order; null where not entered. */
  scores: (number | null)[];
  total: number | null;
  grade: string | null;
  remark: string | null;
  /** Position in the class for this subject, among students with a total. */
  position: number | null;
}

export interface StudentResult {
  studentId: string;
  subjects: SubjectResult[];
  /** Sum of subject totals, only when every subject has one. */
  total: number | null;
  /** Mean subject total to one decimal, only when every subject has one. */
  average: number | null;
  /** Position in the class by overall total, among students with every subject complete. */
  position: number | null;
  /** Subjects with every component scored. */
  graded: number;
}

/** Results for a whole class: every student's subjects, totals, grades and positions. */
export function classResults(input: {
  components: readonly AssessmentComponent[];
  bands: readonly GradeBand[];
  subjects: readonly { id: string; name: string }[];
  studentIds: readonly string[];
  /** scores[studentId][subjectId][componentKey] = tenths */
  scores: ReadonlyMap<string, ReadonlyMap<string, Readonly<Record<string, number>>>>;
}): Map<string, StudentResult> {
  const { components, bands, subjects, studentIds, scores } = input;
  const totals = new Map<string, Map<string, number | null>>();
  for (const studentId of studentIds) {
    const bySubject = new Map<string, number | null>();
    for (const subject of subjects)
      bySubject.set(subject.id, subjectTotal(components, scores.get(studentId)?.get(subject.id) ?? {}));
    totals.set(studentId, bySubject);
  }
  const subjectPositions = new Map<string, Map<string, number>>();
  for (const subject of subjects) {
    const values = new Map<string, number>();
    for (const studentId of studentIds) {
      const t = totals.get(studentId)!.get(subject.id);
      if (t !== null && t !== undefined) values.set(studentId, t);
    }
    subjectPositions.set(subject.id, positions(values));
  }
  const overall = new Map<string, number>();
  for (const studentId of studentIds) {
    const values = [...totals.get(studentId)!.values()];
    if (subjects.length > 0 && values.every((v) => v !== null))
      overall.set(
        studentId,
        values.reduce<number>((sum, v) => sum + (v ?? 0), 0),
      );
  }
  const overallPositions = positions(overall);

  const results = new Map<string, StudentResult>();
  for (const studentId of studentIds) {
    const studentScores = scores.get(studentId);
    const subjectResults = subjects.map((subject): SubjectResult => {
      const total = totals.get(studentId)!.get(subject.id) ?? null;
      const band = total === null ? null : bandFor(bands, total);
      const entered = studentScores?.get(subject.id) ?? {};
      return {
        subjectId: subject.id,
        name: subject.name,
        scores: components.map((c) => entered[c.key] ?? null),
        total,
        grade: band?.grade ?? null,
        remark: band?.remark ?? null,
        position: subjectPositions.get(subject.id)!.get(studentId) ?? null,
      };
    });
    const total = overall.get(studentId) ?? null;
    results.set(studentId, {
      studentId,
      subjects: subjectResults,
      total,
      average: total === null ? null : Math.round((total * 10) / subjects.length) / 10,
      position: overallPositions.get(studentId) ?? null,
      graded: subjectResults.filter((s) => s.total !== null).length,
    });
  }
  return results;
}

export interface ReportRemarks {
  attitude: string | null;
  conduct: string | null;
  interest: string | null;
  classTeacher: string | null;
  headTeacher: string | null;
}

/**
 * Everything a report card shows, frozen when it is published so later changes (scores of other students,
 * weights, grade bands, names) never alter a report a family has received. Drafts use the same shape,
 * worked out live.
 */
export interface ReportCardSnapshot {
  version: 1;
  schoolName: string;
  term: { name: string; yearName: string; nextTermBeginsOn: string | null };
  student: { name: string; admissionNumber: string; className: string; levelName: string };
  classSize: number;
  components: AssessmentComponent[];
  bands: GradeBand[];
  showPositions: boolean;
  subjects: Omit<SubjectResult, "subjectId">[];
  overall: { total: number | null; average: number | null; position: number | null; graded: number };
  attendance: { present: number | null; open: number | null };
  remarks: ReportRemarks;
  classTeacherName: string | null;
  /** Who published it, and the school-local date. Null on drafts. */
  approvedBy: string | null;
  approvedOn: string | null;
}
