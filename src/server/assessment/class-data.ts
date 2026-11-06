import "server-only";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import {
  classResults,
  type AssessmentComponent,
  type GradeBand,
  type ReportCardSnapshot,
  type StudentResult,
} from "../../lib/assessment";
import type { Transaction } from "../db/client";
import { academicYears, assessmentScores, enrolments, reportCards, students, terms } from "../db/schema";
import { fullName } from "../students/service";
import type { AssessableClass, TermRef } from "./access";
import { readBands, readLevelSubjects, readScheme } from "./setup";

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
  subjects: { id: string; name: string }[];
  components: AssessmentComponent[];
  showPositions: boolean;
  bands: GradeBand[];
  /** scores[studentId][subjectId][componentKey] = tenths */
  scores: Map<string, Map<string, Record<string, number>>>;
  cards: Map<string, ReportCardRow>;
  results: Map<string, StudentResult>;
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
  return {
    term,
    cls,
    students: roster,
    subjects: subjectList,
    components: scheme.components,
    showPositions: scheme.showPositions,
    bands,
    scores,
    cards: new Map(cardRows.map((c) => [c.studentId, c])),
    results: classResults({
      components: scheme.components,
      bands,
      subjects: subjectList,
      studentIds: ids,
      scores,
    }),
  };
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
    subjects: result.subjects.map(({ subjectId: _id, ...rest }) => rest),
    overall: {
      total: result.total,
      average: result.average,
      position: result.position,
      graded: result.graded,
    },
    attendance: { present: card?.daysPresent ?? null, open: card?.daysOpen ?? null },
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
