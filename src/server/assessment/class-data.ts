import "server-only";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import {
  classResults,
  type AssessmentComponent,
  type GradeBand,
  type ReportCardSnapshot,
  type StudentResult,
} from "../../lib/assessment";
import type { AttendanceTotals } from "../../lib/attendance";
import { readAttendanceTotals } from "../attendance/totals";
import type { Transaction } from "../db/client";
import type { ReportCardStyle } from "../../lib/report-styles";
import { readTemplate } from "../academics/templates";
import {
  academicYears,
  assessmentScores,
  enrolments,
  reportCards,
  studentSubjectChoices,
  students,
  subjectComments,
  terms,
} from "../db/schema";
import { readPreferences } from "../tenancy/preferences";
import { fullName } from "../students/service";
import type { AssessableClass, TermRef } from "./access";
import { readBands, readLevelSubjects, readScheme } from "./setup";
import { subjectTeachersIn } from "./teaching";

export interface ClassStudent {
  id: string;
  name: string;
  firstName: string;
  admissionNumber: string;
}

export type ReportCardRow = typeof reportCards.$inferSelect;

/** Everything about one class in one term that score sheets, results and report cards are built from. */
export interface ClassTermData {
  term: TermRef;
  cls: AssessableClass;
  students: ClassStudent[];
  subjects: { id: string; name: string; elective: boolean }[];
  /** choices[studentId] = the elective subjects the student takes (2026-11-18). */
  choices: Map<string, Set<string>>;
  components: AssessmentComponent[];
  showPositions: boolean;
  bands: GradeBand[];
  /** scores[studentId][subjectId][componentKey] = tenths */
  scores: Map<string, Map<string, Record<string, number>>>;
  cards: Map<string, ReportCardRow>;
  results: Map<string, StudentResult>;
  /** Attendance from the term's registers. */
  attendance: Map<string, AttendanceTotals>;
  /** comments[studentId][subjectId] = the subject teacher's comment */
  comments: Map<string, Map<string, string>>;
  /** Who teaches each subject in the class: its subject teacher, else the class teacher. */
  teachers: Map<string, string | null>;
  /** The school's report-card layout. */
  style: ReportCardStyle;
}

/** The layout a school prints: its own choice, else the one that suits its template. */
export async function readReportCardStyle(tx: Transaction, tenantId: string): Promise<ReportCardStyle> {
  return (
    (await readPreferences(tx, tenantId)).reportCardStyle ?? (await readTemplate(tx, tenantId)).reportStyle
  );
}

/** Students in the class for the term, by surname then first name. */
export async function classStudents(
  tx: Transaction,
  tenantId: string,
  termId: string,
  classId: string,
): Promise<ClassStudent[]> {
  const rows = await tx
    .select({
      id: students.id,
      firstName: students.firstName,
      otherNames: students.otherNames,
      lastName: students.lastName,
      admissionNumber: students.admissionNumber,
    })
    .from(enrolments)
    .innerJoin(students, eq(students.id, enrolments.studentId))
    .where(
      and(eq(enrolments.tenantId, tenantId), eq(enrolments.termId, termId), eq(enrolments.classId, classId)),
    )
    .orderBy(asc(students.lastName), asc(students.firstName));
  return rows.map((r) => ({
    id: r.id,
    name: fullName(r),
    firstName: r.firstName,
    admissionNumber: r.admissionNumber,
  }));
}

export async function loadClassTermData(
  tx: Transaction,
  tenantId: string,
  term: TermRef,
  cls: AssessableClass,
): Promise<ClassTermData> {
  const roster = await classStudents(tx, tenantId, term.id, cls.id);
  const subjectList = await readLevelSubjects(tx, tenantId, cls.levelId);
  const scheme = await readScheme(tx, tenantId, term.id);
  const bands = await readBands(tx, tenantId, cls.stage);
  const ids = roster.map((s) => s.id);
  const scoreRows = ids.length
    ? await tx
        .select({
          studentId: assessmentScores.studentId,
          subjectId: assessmentScores.subjectId,
          key: assessmentScores.componentKey,
          tenths: assessmentScores.scoreTenths,
        })
        .from(assessmentScores)
        .where(
          and(
            eq(assessmentScores.tenantId, tenantId),
            eq(assessmentScores.termId, term.id),
            inArray(assessmentScores.studentId, ids),
          ),
        )
    : [];
  const scores = new Map<string, Map<string, Record<string, number>>>();
  for (const row of scoreRows) {
    const bySubject = scores.get(row.studentId) ?? new Map<string, Record<string, number>>();
    const entry = bySubject.get(row.subjectId) ?? {};
    entry[row.key] = row.tenths;
    bySubject.set(row.subjectId, entry);
    scores.set(row.studentId, bySubject);
  }
  const cardRows = ids.length
    ? await tx
        .select()
        .from(reportCards)
        .where(
          and(
            eq(reportCards.tenantId, tenantId),
            eq(reportCards.termId, term.id),
            inArray(reportCards.studentId, ids),
          ),
        )
    : [];
  const commentRows = ids.length
    ? await tx
        .select({
          studentId: subjectComments.studentId,
          subjectId: subjectComments.subjectId,
          comment: subjectComments.comment,
        })
        .from(subjectComments)
        .where(
          and(
            eq(subjectComments.tenantId, tenantId),
            eq(subjectComments.termId, term.id),
            inArray(subjectComments.studentId, ids),
          ),
        )
    : [];
  const comments = new Map<string, Map<string, string>>();
  for (const row of commentRows) {
    const bySubject = comments.get(row.studentId) ?? new Map<string, string>();
    bySubject.set(row.subjectId, row.comment);
    comments.set(row.studentId, bySubject);
  }
  const assigned = new Map(
    (await subjectTeachersIn(tx, tenantId, cls.id)).map((t) => [t.subjectId, t.teacherName]),
  );
  const electives = new Set(subjectList.filter((s) => s.elective).map((s) => s.id));
  const choices = await readSubjectChoices(tx, tenantId, ids, [...electives]);
  return {
    term,
    cls,
    comments,
    teachers: new Map(subjectList.map((s) => [s.id, assigned.get(s.id) ?? cls.classTeacherName])),
    style: await readReportCardStyle(tx, tenantId),
    students: roster,
    subjects: subjectList,
    choices,
    components: scheme.components,
    showPositions: scheme.showPositions,
    bands,
    scores,
    cards: new Map(cardRows.map((c) => [c.studentId, c])),
    attendance: await readAttendanceTotals(tx, tenantId, term.id, ids),
    results: classResults({
      components: scheme.components,
      bands,
      subjects: subjectList,
      studentIds: ids,
      scores,
      electives,
      choices,
      aggregate: usesBeceAggregate(cls.stage, bands) ? "bece" : null,
    }),
  };
}

/** JHS graded on the 1–9 scale (Ghana's): report cards show the BECE-style aggregate. */
export function usesBeceAggregate(stage: string, bands: readonly GradeBand[]): boolean {
  return stage === "jhs" && bands.length > 0 && bands.every((b) => /^[1-9]$/.test(b.grade));
}

/** The electives each student takes, among those given (2026-11-18). */
export async function readSubjectChoices(
  tx: Transaction,
  tenantId: string,
  studentIds: readonly string[],
  subjectIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  const choices = new Map<string, Set<string>>();
  if (studentIds.length === 0 || subjectIds.length === 0) return choices;
  const rows = await tx
    .select({ studentId: studentSubjectChoices.studentId, subjectId: studentSubjectChoices.subjectId })
    .from(studentSubjectChoices)
    .where(
      and(
        eq(studentSubjectChoices.tenantId, tenantId),
        inArray(studentSubjectChoices.studentId, [...studentIds]),
        inArray(studentSubjectChoices.subjectId, [...subjectIds]),
      ),
    );
  for (const r of rows) {
    const set = choices.get(r.studentId) ?? new Set<string>();
    set.add(r.subjectId);
    choices.set(r.studentId, set);
  }
  return choices;
}

/** The term's academic year name and the start of the next term (shown as "Next term begins"). */
export async function termContext(
  tx: Transaction,
  tenantId: string,
  term: TermRef,
): Promise<{ yearName: string; nextTermBeginsOn: string | null }> {
  const [year] = await tx
    .select({ name: academicYears.name })
    .from(terms)
    .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
    .where(and(eq(terms.tenantId, tenantId), eq(terms.id, term.id)));
  const [next] = await tx
    .select({ startsOn: terms.startsOn })
    .from(terms)
    .where(and(eq(terms.tenantId, tenantId), gt(terms.startsOn, term.endsOn)))
    .orderBy(asc(terms.startsOn))
    .limit(1);
  return { yearName: year?.name ?? "", nextTermBeginsOn: next?.startsOn ?? null };
}

/** A report card as it stands now (drafts), built from live data. */
export function buildSnapshot(
  data: ClassTermData,
  student: ClassStudent,
  extra: {
    schoolName: string;
    yearName: string;
    nextTermBeginsOn: string | null;
    approvedBy: string | null;
    approvedOn: string | null;
  },
): ReportCardSnapshot {
  const result = data.results.get(student.id)!;
  const card = data.cards.get(student.id);
  return {
    version: 1,
    schoolName: extra.schoolName,
    term: { name: data.term.name, yearName: extra.yearName, nextTermBeginsOn: extra.nextTermBeginsOn },
    student: {
      name: student.name,
      admissionNumber: student.admissionNumber,
      className: data.cls.name,
      levelName: data.cls.levelName,
    },
    classSize: data.students.length,
    components: data.components,
    bands: data.bands,
    showPositions: data.showPositions,
    subjects: result.subjects.map(({ subjectId, ...rest }) => ({
      ...rest,
      comment: data.comments.get(student.id)?.get(subjectId) ?? null,
      teacher: data.teachers.get(subjectId) ?? null,
    })),
    overall: {
      total: result.total,
      average: result.average,
      position: result.position,
      graded: result.graded,
      gpa: result.gpa,
      ...(result.aggregate !== null ? { aggregate: result.aggregate } : {}),
    },
    style: data.style,
    attendance: reportAttendance(card, data.attendance.get(student.id)),
    remarks: {
      attitude: card?.attitude ?? null,
      conduct: card?.conduct ?? null,
      interest: card?.interest ?? null,
      classTeacher: card?.classTeacherRemark ?? null,
      headTeacher: card?.headTeacherRemark ?? null,
    },
    classTeacherName: data.cls.classTeacherName,
    approvedBy: extra.approvedBy,
    approvedOn: extra.approvedOn,
  };
}

/**
 * Days present and days open for a report card: from the registers, unless the school typed figures in (for
 * terms before registers were kept, or to correct them). Null when neither exists.
 */
export function reportAttendance(
  card: Pick<ReportCardRow, "daysPresent" | "daysOpen"> | undefined,
  registers: AttendanceTotals | undefined,
): { present: number | null; open: number | null } {
  const fromRegisters = registers && registers.open > 0;
  return {
    present: card?.daysPresent ?? (fromRegisters ? registers.present + registers.late : null),
    open: card?.daysOpen ?? (fromRegisters ? registers.open : null),
  };
}
