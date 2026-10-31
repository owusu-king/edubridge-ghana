import "server-only";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertCan, can } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  academicYears,
  classes,
  enrolments,
  levels,
  memberships,
  students,
  tenantCounters,
  terms,
} from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import type { TenantContext } from "../tenancy/service";

export const PAGE_SIZE = 50;
const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenant.id, userId: ctx.userId });

/** Treats blank form values as missing. Optional at the key level, so the field may be omitted. */
const blank = (v: unknown) => (v === "" || v === null ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional()).optional();

export const studentSchema = z.object({
  firstName: z.string().trim().min(1, "Enter the first name.").max(60, "Use 60 characters or fewer."),
  otherNames: optional(z.string().trim().max(60, "Use 60 characters or fewer.")),
  lastName: z.string().trim().min(1, "Enter the surname.").max(60, "Use 60 characters or fewer."),
  sex: z.enum(["female", "male"], { message: "Choose female or male." }),
  dateOfBirth: optional(
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date.")
      .refine((d) => d < new Date().toISOString().slice(0, 10), "The date of birth must be in the past."),
  ),
  admissionNumber: optional(z.string().trim().max(30, "Use 30 characters or fewer.")),
});

export const createStudentSchema = studentSchema.extend({
  classId: optional(z.string().uuid("Choose a class.")),
});

export interface StudentRow {
  id: string;
  admissionNumber: string;
  fullName: string;
  sex: "female" | "male";
  status: "active" | "withdrawn" | "graduated";
  className: string | null;
  classId: string | null;
}

export function fullName(s: { firstName: string; otherNames: string | null; lastName: string }): string {
  return [s.firstName, s.otherNames, s.lastName].filter(Boolean).join(" ");
}

async function currentTermId(tx: Transaction, tenantId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: terms.id })
    .from(terms)
    .where(and(eq(terms.tenantId, tenantId), eq(terms.isCurrent, true)));
  return row?.id ?? null;
}

/**
 * Class ids the context may see students of, or null for "all". Teachers: classes where they are class
 * teacher. Campus-scoped staff: classes at their campuses.
 */
async function visibleClassIds(tx: Transaction, ctx: TenantContext): Promise<string[] | null> {
  const viewAll = can(ctx.roles, "students.view_all");
  if (viewAll && ctx.campusIds === null) return null;
  const conditions: SQL[] = [eq(classes.tenantId, ctx.tenant.id)];
  if (ctx.campusIds !== null)
    conditions.push(
      inArray(
        classes.campusId,
        ctx.campusIds.length ? ctx.campusIds : ["00000000-0000-0000-0000-000000000000"],
      ),
    );
  if (!viewAll) {
    const [membership] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.userId, ctx.userId)));
    conditions.push(
      eq(classes.classTeacherMembershipId, membership?.id ?? "00000000-0000-0000-0000-000000000000"),
    );
  }
  const rows = await tx
    .select({ id: classes.id })
    .from(classes)
    .where(and(...conditions));
  return rows.map((r) => r.id);
}

/** Next admission number (0001, 0002, …), skipping any number already used, e.g. by imported records. */
async function nextAdmissionNumber(tx: Transaction, tenantId: string): Promise<string> {
  for (;;) {
    const [row] = await tx
      .insert(tenantCounters)
      .values({ tenantId, key: "admission_number", value: 1 })
      .onConflictDoUpdate({
        target: [tenantCounters.tenantId, tenantCounters.key],
        set: { value: sql`${tenantCounters.value} + 1` },
      })
      .returning({ value: tenantCounters.value });
    const candidate = String(row!.value).padStart(4, "0");
    const [taken] = await tx
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.tenantId, tenantId), eq(students.admissionNumber, candidate)));
    if (!taken) return candidate;
  }
}

async function assertClass(tx: Transaction, ctx: TenantContext, classId: string): Promise<void> {
  const [cls] = await tx
    .select({ id: classes.id, campusId: classes.campusId })
    .from(classes)
    .where(and(eq(classes.tenantId, ctx.tenant.id), eq(classes.id, classId), eq(classes.status, "active")));
  if (!cls) throw new DomainError("class_invalid", "Choose an active class.", "classId");
  if (ctx.campusIds !== null && !ctx.campusIds.includes(cls.campusId)) {
    throw new DomainError(
      "campus_scope",
      "You can only place students in classes at your campuses.",
      "classId",
    );
  }
}

function mapUnique(error: unknown): never {
  if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
    throw new DomainError(
      "admission_taken",
      "Another student already has this admission number.",
      "admissionNumber",
    );
  }
  throw error;
}

export async function createStudent(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<{ id: string; admissionNumber: string }> {
  assertCan(ctx.roles, "students.manage");
  const data = createStudentSchema.parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    let termId: string | null = null;
    if (data.classId) {
      await assertClass(tx, ctx, data.classId);
      termId = await currentTermId(tx, ctx.tenant.id);
      if (!termId)
        throw new DomainError(
          "no_current_term",
          "Set the current term in Settings → Calendar before placing students in classes.",
          "classId",
        );
    }
    const admissionNumber = data.admissionNumber ?? (await nextAdmissionNumber(tx, ctx.tenant.id));
    const [student] = await tx
      .insert(students)
      .values({
        tenantId: ctx.tenant.id,
        admissionNumber,
        firstName: data.firstName,
        otherNames: data.otherNames ?? null,
        lastName: data.lastName,
        sex: data.sex,
        dateOfBirth: data.dateOfBirth ?? null,
        admittedOn: new Date().toISOString().slice(0, 10),
      })
      .returning({ id: students.id });
    if (data.classId && termId) {
      await tx
        .insert(enrolments)
        .values({ tenantId: ctx.tenant.id, studentId: student!.id, termId, classId: data.classId });
    }
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "student.created",
      entityType: "student",
      entityId: student!.id,
      metadata: { admissionNumber },
    });
    return { id: student!.id, admissionNumber };
  }).catch(mapUnique);
}

export interface ListStudentsInput {
  q?: string;
  classId?: string;
  status?: "active" | "withdrawn" | "graduated";
  page?: number;
}

export async function listStudents(
  database: Database,
  ctx: TenantContext,
  input: ListStudentsInput = {},
): Promise<{ rows: StudentRow[]; total: number; page: number; termName: string | null }> {
  assertCan(ctx.roles, "students.view");
  const page = Math.max(1, Math.floor(input.page ?? 1));
  return withTenant(database, scope(ctx), async (tx) => {
    const [term] = await tx
      .select({ id: terms.id, name: terms.name, yearName: academicYears.name })
      .from(terms)
      .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
      .where(and(eq(terms.tenantId, ctx.tenant.id), eq(terms.isCurrent, true)));
    const visible = await visibleClassIds(tx, ctx);
    const conditions: SQL[] = [
      eq(students.tenantId, ctx.tenant.id),
      eq(students.status, input.status ?? "active"),
    ];
    const q = input.q?.trim().slice(0, 60);
    if (q) {
      const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(
        or(
          ilike(students.firstName, pattern),
          ilike(students.lastName, pattern),
          ilike(students.otherNames, pattern),
          ilike(students.admissionNumber, pattern),
          ilike(sql`${students.firstName} || ' ' || ${students.lastName}`, pattern),
        )!,
      );
    }
    if (input.classId && z.string().uuid().safeParse(input.classId).success)
      conditions.push(eq(enrolments.classId, input.classId));
    if (input.classId === "none") conditions.push(isNull(enrolments.id));
    if (visible !== null) {
      conditions.push(
        inArray(enrolments.classId, visible.length ? visible : ["00000000-0000-0000-0000-000000000000"]),
      );
    }
    const base = tx
      .select({
        id: students.id,
        admissionNumber: students.admissionNumber,
        firstName: students.firstName,
        otherNames: students.otherNames,
        lastName: students.lastName,
        sex: students.sex,
        status: students.status,
        classId: classes.id,
        className: classes.name,
        total: sql<number>`count(*) over ()::int`,
      })
      .from(students)
      .leftJoin(
        enrolments,
        and(
          eq(enrolments.studentId, students.id),
          eq(enrolments.termId, term?.id ?? "00000000-0000-0000-0000-000000000000"),
        ),
      )
      .leftJoin(classes, eq(classes.id, enrolments.classId))
      .where(and(...conditions))
      .orderBy(asc(students.lastName), asc(students.firstName), asc(students.admissionNumber))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE);
    const rows = await base;
    return {
      rows: rows.map((r) => ({
        id: r.id,
        admissionNumber: r.admissionNumber,
        fullName: fullName(r),
        sex: r.sex,
        status: r.status,
        classId: r.classId,
        className: r.className,
      })),
      total: rows[0]?.total ?? 0,
      page,
      termName: term ? `${term.name}, ${term.yearName}` : null,
    };
  });
}

export interface StudentDetail {
  id: string;
  admissionNumber: string;
  firstName: string;
  otherNames: string | null;
  lastName: string;
  fullName: string;
  sex: "female" | "male";
  dateOfBirth: string | null;
  admittedOn: string | null;
  status: "active" | "withdrawn" | "graduated";
  currentClass: { id: string; name: string } | null;
  history: { termName: string; yearName: string; className: string; levelName: string }[];
}

export async function getStudent(
  database: Database,
  ctx: TenantContext,
  studentId: string,
): Promise<StudentDetail | null> {
  assertCan(ctx.roles, "students.view");
  if (!z.string().uuid().safeParse(studentId).success) return null;
  return withTenant(database, scope(ctx), async (tx) => {
    const [student] = await tx
      .select()
      .from(students)
      .where(and(eq(students.tenantId, ctx.tenant.id), eq(students.id, studentId)));
    if (!student) return null;
    const history = await tx
      .select({
        termId: terms.id,
        isCurrent: terms.isCurrent,
        termName: terms.name,
        yearName: academicYears.name,
        classId: classes.id,
        className: classes.name,
        levelName: levels.name,
      })
      .from(enrolments)
      .innerJoin(terms, eq(terms.id, enrolments.termId))
      .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
      .innerJoin(classes, eq(classes.id, enrolments.classId))
      .innerJoin(levels, eq(levels.id, classes.levelId))
      .where(and(eq(enrolments.tenantId, ctx.tenant.id), eq(enrolments.studentId, student.id)))
      .orderBy(desc(terms.startsOn));
    const current = history.find((h) => h.isCurrent);
    // Same visibility rule as the list: restricted staff only see students in their classes this term.
    const visible = await visibleClassIds(tx, ctx);
    if (visible !== null && (!current || !visible.includes(current.classId))) return null;
    return {
      id: student.id,
      admissionNumber: student.admissionNumber,
      firstName: student.firstName,
      otherNames: student.otherNames,
      lastName: student.lastName,
      fullName: fullName(student),
      sex: student.sex,
      dateOfBirth: student.dateOfBirth,
      admittedOn: student.admittedOn,
      status: student.status,
      currentClass: current ? { id: current.classId, name: current.className } : null,
      history: history.map(({ termName, yearName, className, levelName }) => ({
        termName,
        yearName,
        className,
        levelName,
      })),
    };
  });
}

async function loadStudent(tx: Transaction, ctx: TenantContext, studentId: string) {
  if (!z.string().uuid().safeParse(studentId).success)
    throw new DomainError("student_not_found", "Student not found.");
  const [student] = await tx
    .select()
    .from(students)
    .where(and(eq(students.tenantId, ctx.tenant.id), eq(students.id, studentId)))
    .for("update");
  if (!student) throw new DomainError("student_not_found", "Student not found.");
  return student;
}

export async function updateStudent(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  input: unknown,
): Promise<void> {
  assertCan(ctx.roles, "students.manage");
  const data = studentSchema.parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    const before = await loadStudent(tx, ctx, studentId);
    const next = {
      firstName: data.firstName,
      otherNames: data.otherNames ?? null,
      lastName: data.lastName,
      sex: data.sex,
      dateOfBirth: data.dateOfBirth ?? null,
      admissionNumber: data.admissionNumber ?? before.admissionNumber,
    };
    await tx
      .update(students)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(students.id, before.id));
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of [
      "firstName",
      "otherNames",
      "lastName",
      "sex",
      "dateOfBirth",
      "admissionNumber",
    ] as const) {
      if ((before[key] ?? null) !== (next[key] ?? null)) changes[key] = { from: before[key], to: next[key] };
    }
    if (Object.keys(changes).length) {
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "student.updated",
        entityType: "student",
        entityId: before.id,
        metadata: { changes },
      });
    }
  }).catch(mapUnique);
}

/** Places a student in a class for the current term, or moves them to another class. */
export async function assignClass(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  classId: string,
): Promise<void> {
  assertCan(ctx.roles, "students.manage");
  await withTenant(database, scope(ctx), async (tx) => {
    const student = await loadStudent(tx, ctx, studentId);
    if (student.status !== "active")
      throw new DomainError("student_inactive", "Only active students can be placed in a class.");
    if (!z.string().uuid().safeParse(classId).success)
      throw new DomainError("class_invalid", "Choose a class.", "classId");
    await assertClass(tx, ctx, classId);
    const termId = await currentTermId(tx, ctx.tenant.id);
    if (!termId)
      throw new DomainError(
        "no_current_term",
        "Set the current term in Settings → Calendar first.",
        "classId",
      );
    const [existing] = await tx
      .select()
      .from(enrolments)
      .where(and(eq(enrolments.termId, termId), eq(enrolments.studentId, student.id)));
    if (existing?.classId === classId) return;
    await tx
      .insert(enrolments)
      .values({ tenantId: ctx.tenant.id, studentId: student.id, termId, classId })
      .onConflictDoUpdate({
        target: [enrolments.termId, enrolments.studentId],
        set: { classId, updatedAt: new Date() },
      });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: existing ? "student.class_changed" : "student.enrolled",
      entityType: "student",
      entityId: student.id,
      metadata: { from: existing?.classId ?? null, to: classId, termId },
    });
  });
}

/** Withdrawn and graduated students keep their records; they drop out of class lists and billing. */
export async function setStudentStatus(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  status: "active" | "withdrawn" | "graduated",
): Promise<void> {
  assertCan(ctx.roles, "students.manage");
  const parsed = z.enum(["active", "withdrawn", "graduated"]).parse(status);
  await withTenant(database, scope(ctx), async (tx) => {
    const student = await loadStudent(tx, ctx, studentId);
    if (student.status === parsed) return;
    await tx
      .update(students)
      .set({ status: parsed, updatedAt: new Date() })
      .where(eq(students.id, student.id));
    if (parsed !== "active") {
      // Leave the current term's class so the student is not counted there.
      const termId = await currentTermId(tx, ctx.tenant.id);
      if (termId)
        await tx
          .delete(enrolments)
          .where(and(eq(enrolments.termId, termId), eq(enrolments.studentId, student.id)));
    }
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: `student.${parsed === "active" ? "reactivated" : parsed}`,
      entityType: "student",
      entityId: student.id,
      metadata: { from: student.status, to: parsed },
    });
  });
}

/** Active classes the context may place students in, for pickers. */
export async function listClassOptions(
  database: Database,
  ctx: TenantContext,
): Promise<{ id: string; name: string; levelName: string }[]> {
  assertCan(ctx.roles, "students.view");
  return withTenant(database, scope(ctx), async (tx) => {
    const rows = await tx
      .select({ id: classes.id, name: classes.name, levelName: levels.name, campusId: classes.campusId })
      .from(classes)
      .innerJoin(levels, eq(levels.id, classes.levelId))
      .where(and(eq(classes.tenantId, ctx.tenant.id), eq(classes.status, "active")))
      .orderBy(asc(levels.sequence), asc(classes.name));
    return rows
      .filter((r) => ctx.campusIds === null || ctx.campusIds.includes(r.campusId))
      .map(({ id, name, levelName }) => ({ id, name, levelName }));
  });
}
