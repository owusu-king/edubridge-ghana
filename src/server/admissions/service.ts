import "server-only";
import { and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  APPLICATION_RETENTION_MONTHS,
  APPLICATION_SOURCES,
  APPLICATION_STATUSES,
  applicationReference,
  canMove,
  CLOSED_APPLICATION_STATUSES,
  OPEN_APPLICATION_STATUSES,
  type AdmissionFee,
  type ApplicationSource,
  type ApplicationStatus,
} from "../../lib/admissions";
import { localToUtc, todayIn } from "../../lib/format";
import { localizePhoneField, normalizePhone } from "../../lib/phone";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  applicationEvents,
  applications,
  campuses,
  classes,
  enrolments,
  ledgerEntries,
  levels,
  students,
  tenantCounters,
  tenants,
  terms,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import { linkGuardianInTx, RELATIONSHIPS } from "../students/guardian-links";
import { assertStudentCapacity, nextAdmissionNumber } from "../students/service";
import { readPreferences } from "../tenancy/preferences";
import type { TenantContext } from "../tenancy/service";

/**
 * Admissions (R3-4): a school's applicants from first contact to enrolment (ADM-01 to ADM-08). Applicants
 * are not students (D-R3-1): nothing about them appears in class lists, fees, limits or exports until they
 * are enrolled, which creates the student, places them in the offered class for the entry term and posts
 * the offer's admission fees to their account, in one transaction and only once.
 *
 * Every status change is kept (`application_events`, insert-only) and audited. A closed application
 * (enrolled, declined, withdrawn) never reopens (database trigger). Declined and withdrawn applications
 * lose their personal details 12 months after closing (D-R3-2, `eraseExpiredApplications`).
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) =>
  z.preprocess(blank, z.string().trim().max(max, `Use ${max} characters or fewer.`).optional());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date.");

export const applicantSchema = z.object({
  childFirstName: z
    .string()
    .trim()
    .min(1, "Enter the child's first name.")
    .max(60, "Use 60 characters or fewer."),
  childOtherNames: optionalText(60),
  childLastName: z
    .string()
    .trim()
    .min(1, "Enter the child's surname.")
    .max(60, "Use 60 characters or fewer."),
  sex: z.preprocess(blank, z.enum(["female", "male"], { message: "Choose female or male." }).optional()),
  dateOfBirth: z.preprocess(
    blank,
    isoDate
      .refine((d) => d < new Date().toISOString().slice(0, 10), "The date of birth must be in the past.")
      .optional(),
  ),
  previousSchool: optionalText(120),
  levelId: z.string().uuid("Choose the level applied for."),
  entryTermId: z.preprocess(blank, z.string().uuid().optional()),
  guardianName: z
    .string()
    .trim()
    .min(2, "Enter the parent or guardian's full name.")
    .max(120, "Use 120 characters or fewer."),
  guardianPhone: z.string().trim().min(1, "Enter a phone number."),
  guardianEmail: z.preprocess(
    blank,
    z.string().trim().toLowerCase().email("Enter a valid email address.").max(254).optional(),
  ),
  guardianRelationship: z.enum(RELATIONSHIPS, { message: "Choose a relationship." }),
  notes: optionalText(1000),
});

export type ApplicantInput = z.infer<typeof applicantSchema>;

/** Parses an applicant, reading the phone in the school's country. */
export function parseApplicant(input: unknown, country: string): ApplicantInput & { phone: string } {
  const data = applicantSchema.parse(localizePhoneField(input, country, "guardianPhone"));
  const phone = normalizePhone(data.guardianPhone, country);
  if (!phone)
    throw new DomainError(
      "phone_invalid",
      "Enter a valid mobile number, e.g. 024 123 4567.",
      "guardianPhone",
    );
  return { ...data, phone };
}

async function nextReference(tx: Transaction, tenantId: string): Promise<string> {
  const [row] = await tx
    .insert(tenantCounters)
    .values({ tenantId, key: "application_reference", value: 1 })
    .onConflictDoUpdate({
      target: [tenantCounters.tenantId, tenantCounters.key],
      set: { value: sql`${tenantCounters.value} + 1` },
    })
    .returning({ value: tenantCounters.value });
  return applicationReference(row!.value);
}

async function assertLevelAndTerm(
  tx: Transaction,
  tenantId: string,
  levelId: string,
  termId?: string | null,
) {
  const [level] = await tx
    .select({ id: levels.id })
    .from(levels)
    .where(and(eq(levels.tenantId, tenantId), eq(levels.id, levelId), eq(levels.status, "active")));
  if (!level) throw new DomainError("level_invalid", "Choose a level the school teaches.", "levelId");
  if (termId) {
    const [term] = await tx
      .select({ id: terms.id })
      .from(terms)
      .where(and(eq(terms.tenantId, tenantId), eq(terms.id, termId)));
    if (!term) throw new DomainError("term_invalid", "Choose a term.", "entryTermId");
  }
}

/**
 * Inserts a new application with its first event (staff, or an online application once its phone was
 * checked). Runs in the caller's tenant transaction.
 */
export async function insertApplication(
  tx: Transaction,
  tenantId: string,
  data: ApplicantInput & { phone: string },
  opts: { status: "inquiry" | "applied"; source: ApplicationSource; actorUserId: string | null },
): Promise<{ id: string; reference: string }> {
  await assertLevelAndTerm(tx, tenantId, data.levelId, data.entryTermId);
  const reference = await nextReference(tx, tenantId);
  const [row] = await tx
    .insert(applications)
    .values({
      tenantId,
      reference,
      status: opts.status,
      source: opts.source,
      childFirstName: data.childFirstName,
      childOtherNames: data.childOtherNames ?? null,
      childLastName: data.childLastName,
      sex: data.sex ?? null,
      dateOfBirth: data.dateOfBirth ?? null,
      previousSchool: data.previousSchool ?? null,
      levelId: data.levelId,
      entryTermId: data.entryTermId ?? null,
      guardianName: data.guardianName,
      guardianPhone: data.phone,
      guardianEmail: data.guardianEmail ?? null,
      guardianRelationship: data.guardianRelationship,
      notes: data.notes ?? null,
      createdByUserId: opts.actorUserId,
    })
    .returning({ id: applications.id });
  await tx.insert(applicationEvents).values({
    tenantId,
    applicationId: row!.id,
    fromStatus: null,
    toStatus: opts.status,
    note: opts.source === "online" ? "Applied online; phone confirmed by SMS code." : null,
    actorUserId: opts.actorUserId,
  });
  await recordAudit(tx, {
    tenantId,
    actorUserId: opts.actorUserId,
    action: "application.created",
    entityType: "application",
    entityId: row!.id,
    metadata: { reference, status: opts.status, source: opts.source },
  });
  return { id: row!.id, reference };
}

/** A staff member records an inquiry or an application (ADM-01). */
export async function createApplication(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<{ id: string; reference: string }> {
  assertAllowed(ctx, "admissions.manage");
  const raw = (input ?? {}) as Record<string, unknown>;
  const { status, source } = z
    .object({
      status: z.enum(["inquiry", "applied"], { message: "Choose inquiry or application." }),
      source: z.enum(APPLICATION_SOURCES, { message: "Choose how the family heard of the school." }),
    })
    .parse(raw);
  if (source === "online")
    throw new DomainError("source_invalid", "Online applications come through the school's form.", "source");
  const data = parseApplicant(raw, ctx.tenant.countryCode);
  return withTenant(database, scope(ctx), (tx) =>
    insertApplication(tx, ctx.tenant.id, data, { status, source, actorUserId: ctx.userId }),
  );
}

// ——— Reading ———

export interface ApplicationRow {
  id: string;
  reference: string;
  status: ApplicationStatus;
  source: ApplicationSource;
  childName: string;
  levelName: string;
  entryTermName: string | null;
  guardianName: string | null;
  guardianPhone: string | null;
  assessmentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const childName = (r: {
  childFirstName: string | null;
  childOtherNames: string | null;
  childLastName: string | null;
  erasedAt: Date | null;
}) =>
  r.erasedAt
    ? "Details removed"
    : [r.childFirstName, r.childOtherNames, r.childLastName].filter(Boolean).join(" ");

const listQuery = z.object({
  status: z.preprocess(blank, z.enum([...APPLICATION_STATUSES, "open"]).optional()),
  levelId: z.preprocess(blank, z.string().uuid().optional()),
  termId: z.preprocess(blank, z.string().uuid().optional()),
  q: z.preprocess(blank, z.string().trim().max(80).optional()),
});

export interface ApplicationList {
  rows: ApplicationRow[];
  counts: Record<ApplicationStatus, number>;
}

/** Applications, newest first, with how many are at each stage (ADM-03). */
export async function listApplications(
  database: Database,
  ctx: TenantContext,
  input: unknown = {},
): Promise<ApplicationList> {
  assertAllowed(ctx, "admissions.view");
  const q = listQuery.parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    const base: SQL[] = [eq(applications.tenantId, ctx.tenant.id)];
    if (q.levelId) base.push(eq(applications.levelId, q.levelId));
    if (q.termId) base.push(eq(applications.entryTermId, q.termId));
    const counted = await tx
      .select({ status: applications.status, n: sql<number>`count(*)::int` })
      .from(applications)
      .where(and(...base))
      .groupBy(applications.status);
    const conditions = [...base];
    if (q.status === "open") conditions.push(inArray(applications.status, [...OPEN_APPLICATION_STATUSES]));
    else if (q.status) conditions.push(eq(applications.status, q.status));
    if (q.q) {
      const like = `%${q.q.replace(/[%_]/g, "")}%`;
      const digits = q.q.replace(/\D/g, "");
      conditions.push(
        or(
          ilike(applications.childFirstName, like),
          ilike(applications.childLastName, like),
          ilike(applications.guardianName, like),
          ilike(applications.reference, like),
          ...(digits.length >= 6 ? [ilike(applications.guardianPhone, `%${digits.replace(/^0/, "")}%`)] : []),
        )!,
      );
    }
    const rows = await tx
      .select({
        id: applications.id,
        reference: applications.reference,
        status: applications.status,
        source: applications.source,
        childFirstName: applications.childFirstName,
        childOtherNames: applications.childOtherNames,
        childLastName: applications.childLastName,
        erasedAt: applications.erasedAt,
        levelName: levels.name,
        entryTermName: terms.name,
        guardianName: applications.guardianName,
        guardianPhone: applications.guardianPhone,
        assessmentAt: applications.assessmentAt,
        createdAt: applications.createdAt,
        updatedAt: applications.updatedAt,
      })
      .from(applications)
      .innerJoin(levels, eq(levels.id, applications.levelId))
      .leftJoin(terms, eq(terms.id, applications.entryTermId))
      .where(and(...conditions))
      .orderBy(desc(applications.createdAt))
      .limit(300);
    const counts = Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, 0])) as Record<
      ApplicationStatus,
      number
    >;
    for (const c of counted) counts[c.status] = c.n;
    return {
      counts,
      rows: rows.map((r) => ({
        id: r.id,
        reference: r.reference,
        status: r.status,
        source: r.source,
        childName: childName(r),
        levelName: r.levelName,
        entryTermName: r.entryTermName,
        guardianName: r.guardianName,
        guardianPhone: r.guardianPhone,
        assessmentAt: r.assessmentAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    };
  });
}

export interface ApplicationDetail {
  id: string;
  reference: string;
  status: ApplicationStatus;
  source: ApplicationSource;
  erased: boolean;
  child: {
    firstName: string | null;
    otherNames: string | null;
    lastName: string | null;
    name: string;
    sex: "female" | "male" | null;
    dateOfBirth: string | null;
    previousSchool: string | null;
  };
  level: { id: string; name: string };
  entryTerm: { id: string; name: string; startsOn: string } | null;
  guardian: { name: string | null; phone: string | null; email: string | null; relationship: string | null };
  notes: string | null;
  assessment: { at: Date | null; note: string | null };
  offer: {
    at: Date | null;
    classId: string | null;
    className: string | null;
    respondBy: string | null;
    fees: AdmissionFee[];
  };
  student: { id: string; admissionNumber: string } | null;
  createdAt: Date;
  events: {
    from: ApplicationStatus | null;
    to: ApplicationStatus;
    note: string | null;
    by: string | null;
    at: Date;
  }[];
  canManage: boolean;
}

export async function getApplication(
  database: Database,
  ctx: TenantContext,
  id: string,
): Promise<ApplicationDetail | null> {
  assertAllowed(ctx, "admissions.view");
  if (!z.string().uuid().safeParse(id).success) return null;
  return withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .select({
        a: applications,
        levelName: levels.name,
        termName: terms.name,
        termStartsOn: terms.startsOn,
        className: classes.name,
        admissionNumber: students.admissionNumber,
      })
      .from(applications)
      .innerJoin(levels, eq(levels.id, applications.levelId))
      .leftJoin(terms, eq(terms.id, applications.entryTermId))
      .leftJoin(classes, eq(classes.id, applications.offerClassId))
      .leftJoin(students, eq(students.id, applications.studentId))
      .where(and(eq(applications.tenantId, ctx.tenant.id), eq(applications.id, id)));
    if (!row) return null;
    const a = row.a;
    const events = await tx
      .select({
        from: applicationEvents.fromStatus,
        to: applicationEvents.toStatus,
        note: applicationEvents.note,
        by: users.name,
        at: applicationEvents.createdAt,
      })
      .from(applicationEvents)
      .leftJoin(users, eq(users.id, applicationEvents.actorUserId))
      .where(and(eq(applicationEvents.tenantId, ctx.tenant.id), eq(applicationEvents.applicationId, a.id)))
      .orderBy(asc(applicationEvents.createdAt));
    return {
      id: a.id,
      reference: a.reference,
      status: a.status,
      source: a.source,
      erased: a.erasedAt !== null,
      child: {
        firstName: a.childFirstName,
        otherNames: a.childOtherNames,
        lastName: a.childLastName,
        name: childName(a),
        sex: a.sex,
        dateOfBirth: a.dateOfBirth,
        previousSchool: a.previousSchool,
      },
      level: { id: a.levelId, name: row.levelName },
      entryTerm:
        a.entryTermId && row.termName && row.termStartsOn
          ? { id: a.entryTermId, name: row.termName, startsOn: row.termStartsOn }
          : null,
      guardian: {
        name: a.guardianName,
        phone: a.guardianPhone,
        email: a.guardianEmail,
        relationship: a.guardianRelationship,
      },
      notes: a.notes,
      assessment: { at: a.assessmentAt, note: a.assessmentNote },
      offer: {
        at: a.offeredAt,
        classId: a.offerClassId,
        className: row.className,
        respondBy: a.offerRespondBy,
        fees: a.offerFees ?? [],
      },
      student:
        a.studentId && row.admissionNumber ? { id: a.studentId, admissionNumber: row.admissionNumber } : null,
      createdAt: a.createdAt,
      events,
      canManage: allowed(ctx, "admissions.manage") && !CLOSED_APPLICATION_STATUSES.includes(a.status),
    };
  });
}

/** Levels, terms (current and later) and active classes, for the forms. */
export async function admissionOptions(database: Database, ctx: TenantContext) {
  assertAllowed(ctx, "admissions.view");
  return withTenant(database, scope(ctx), async (tx) => {
    const levelRows = await tx
      .select({ id: levels.id, name: levels.name })
      .from(levels)
      .where(and(eq(levels.tenantId, ctx.tenant.id), eq(levels.status, "active")))
      .orderBy(asc(levels.sequence));
    const today = todayIn(ctx.tenant.timezone);
    const termRows = await tx
      .select({ id: terms.id, name: terms.name, startsOn: terms.startsOn, endsOn: terms.endsOn })
      .from(terms)
      .where(and(eq(terms.tenantId, ctx.tenant.id), sql`${terms.endsOn} >= ${today}`))
      .orderBy(asc(terms.startsOn));
    const classRows = await tx
      .select({ id: classes.id, name: classes.name, levelId: classes.levelId, campusName: campuses.name })
      .from(classes)
      .innerJoin(campuses, eq(campuses.id, classes.campusId))
      .where(
        and(
          eq(classes.tenantId, ctx.tenant.id),
          eq(classes.status, "active"),
          ...(ctx.campusIds !== null
            ? [
                inArray(
                  classes.campusId,
                  ctx.campusIds.length ? ctx.campusIds : ["00000000-0000-0000-0000-000000000000"],
                ),
              ]
            : []),
        ),
      )
      .orderBy(asc(classes.name));
    const prefs = await readPreferences(tx, ctx.tenant.id);
    return {
      levels: levelRows,
      terms: termRows,
      classes: classRows,
      admissionFees: prefs.admissionFees,
      onlineApplications: prefs.onlineApplications,
    };
  });
}

// ——— Moving through the pipeline ———

async function loadForUpdate(tx: Transaction, ctx: TenantContext, id: string) {
  if (!z.string().uuid().safeParse(id).success)
    throw new DomainError("application_not_found", "Application not found.");
  const [row] = await tx
    .select()
    .from(applications)
    .where(and(eq(applications.tenantId, ctx.tenant.id), eq(applications.id, id)))
    .for("update");
  if (!row) throw new DomainError("application_not_found", "Application not found.");
  return row;
}

async function addEvent(
  tx: Transaction,
  ctx: TenantContext,
  app: { id: string; reference: string; status: ApplicationStatus },
  to: ApplicationStatus,
  note: string | null,
) {
  await tx.insert(applicationEvents).values({
    tenantId: ctx.tenant.id,
    applicationId: app.id,
    fromStatus: app.status,
    toStatus: to,
    note,
    actorUserId: ctx.userId,
  });
  await recordAudit(tx, {
    tenantId: ctx.tenant.id,
    actorUserId: ctx.userId,
    action: "application.status_changed",
    entityType: "application",
    entityId: app.id,
    metadata: { reference: app.reference, from: app.status, to, note },
  });
}

const noteSchema = (required: boolean) =>
  required
    ? z.string().trim().min(3, "Say why.").max(500, "Use 500 characters or fewer.")
    : z.preprocess(blank, z.string().trim().max(500, "Use 500 characters or fewer.").optional());

/** Edits an open application's details (who, which level and term). */
export async function updateApplication(database: Database, ctx: TenantContext, id: string, input: unknown) {
  assertAllowed(ctx, "admissions.manage");
  const data = parseApplicant(input, ctx.tenant.countryCode);
  await withTenant(database, scope(ctx), async (tx) => {
    const app = await loadForUpdate(tx, ctx, id);
    if (CLOSED_APPLICATION_STATUSES.includes(app.status))
      throw new DomainError("application_closed", "This application is closed.");
    await assertLevelAndTerm(tx, ctx.tenant.id, data.levelId, data.entryTermId);
    await tx
      .update(applications)
      .set({
        childFirstName: data.childFirstName,
        childOtherNames: data.childOtherNames ?? null,
        childLastName: data.childLastName,
        sex: data.sex ?? null,
        dateOfBirth: data.dateOfBirth ?? null,
        previousSchool: data.previousSchool ?? null,
        levelId: data.levelId,
        entryTermId: data.entryTermId ?? null,
        guardianName: data.guardianName,
        guardianPhone: data.phone,
        guardianEmail: data.guardianEmail ?? null,
        guardianRelationship: data.guardianRelationship,
        notes: data.notes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(applications.id, app.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "application.updated",
      entityType: "application",
      entityId: app.id,
      metadata: { reference: app.reference },
    });
  });
}

/**
 * Moves an application on by hand: an inquiry becomes an application; the school declines (with a reason);
 * the family withdraws (with a reason). Offers and enrolment have their own steps.
 */
export async function moveApplication(database: Database, ctx: TenantContext, id: string, input: unknown) {
  assertAllowed(ctx, "admissions.manage");
  const { to } = z.object({ to: z.enum(["applied", "declined", "withdrawn"]) }).parse(input);
  const note = noteSchema(to !== "applied").parse((input as { note?: unknown }).note) ?? null;
  await withTenant(database, scope(ctx), async (tx) => {
    const app = await loadForUpdate(tx, ctx, id);
    if (!canMove(app.status, to))
      throw new DomainError("move_invalid", `An application that is ${app.status} cannot become ${to}.`);
    const closing = to === "declined" || to === "withdrawn";
    await tx
      .update(applications)
      .set({ status: to, ...(closing ? { closedAt: new Date() } : {}), updatedAt: new Date() })
      .where(eq(applications.id, app.id));
    await addEvent(tx, ctx, app, to, note);
  });
}

/** Schedules (or reschedules) the assessment or interview, with an outcome note once it has happened (ADM-04). */
export async function recordAssessment(database: Database, ctx: TenantContext, id: string, input: unknown) {
  assertAllowed(ctx, "admissions.manage");
  const data = z
    .object({
      at: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Choose the day and time.")
        .transform((v) => v),
      note: z.preprocess(blank, z.string().trim().max(500, "Use 500 characters or fewer.").optional()),
    })
    .parse(input);
  // The time typed is the school's local time.
  const at = localToUtc(data.at, ctx.tenant.timezone);
  await withTenant(database, scope(ctx), async (tx) => {
    const app = await loadForUpdate(tx, ctx, id);
    if (app.status !== "applied" && app.status !== "assessment")
      throw new DomainError("move_invalid", "Only an application can be given an assessment.");
    await tx
      .update(applications)
      .set({
        status: "assessment",
        assessmentAt: at,
        assessmentNote: data.note ?? null,
        updatedAt: new Date(),
      })
      .where(eq(applications.id, app.id));
    if (app.status !== "assessment") await addEvent(tx, ctx, app, "assessment", data.note ?? null);
    else
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "application.assessment_updated",
        entityType: "application",
        entityId: app.id,
        metadata: { reference: app.reference, at: at.toISOString() },
      });
  });
}

/**
 * Makes an offer (ADM-05): the entry term, the class (it can be changed at enrolment) and a date to reply
 * by. The school's admission fees are frozen into the offer as they are now.
 */
export async function makeOffer(database: Database, ctx: TenantContext, id: string, input: unknown) {
  assertAllowed(ctx, "admissions.manage");
  const data = z
    .object({
      entryTermId: z.string().uuid("Choose the term the child starts."),
      classId: z.preprocess(blank, z.string().uuid().optional()),
      respondBy: z.preprocess(blank, isoDate.optional()),
    })
    .parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    const app = await loadForUpdate(tx, ctx, id);
    if (app.status !== "applied" && app.status !== "assessment")
      throw new DomainError("move_invalid", "Only an application can be offered a place.");
    await assertLevelAndTerm(tx, ctx.tenant.id, app.levelId, data.entryTermId);
    if (data.classId) await assertClassForLevel(tx, ctx, data.classId, app.levelId);
    const fees = (await readPreferences(tx, ctx.tenant.id)).admissionFees;
    await tx
      .update(applications)
      .set({
        status: "offered",
        entryTermId: data.entryTermId,
        offerClassId: data.classId ?? null,
        offerRespondBy: data.respondBy ?? null,
        offerFees: fees,
        offeredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(applications.id, app.id));
    await addEvent(tx, ctx, app, "offered", fees.length ? `Admission fees: ${fees.length}` : null);
  });
}

async function assertClassForLevel(tx: Transaction, ctx: TenantContext, classId: string, levelId: string) {
  const [cls] = await tx
    .select({ id: classes.id, levelId: classes.levelId, campusId: classes.campusId })
    .from(classes)
    .where(and(eq(classes.tenantId, ctx.tenant.id), eq(classes.id, classId), eq(classes.status, "active")));
  if (!cls) throw new DomainError("class_invalid", "Choose an active class.", "classId");
  if (cls.levelId !== levelId)
    throw new DomainError("class_invalid", "Choose a class of the level applied for.", "classId");
  if (ctx.campusIds !== null && !ctx.campusIds.includes(cls.campusId))
    throw new DomainError("class_invalid", "That class is at a campus you do not manage.", "classId");
}

/**
 * The family accepted: the applicant is enrolled (ADM-06, ADM-07, D-R3-1). In one transaction: the student
 * is created (within the plan's student limit, with the school's next admission number), the guardian is
 * linked (an existing guardian with the same number is reused, so siblings are linked), the child is placed
 * in the class for the entry term, and the offer's admission fees are charged to their account. Enrolling
 * twice returns the same student and charges nothing again.
 */
export async function enrolApplicant(
  database: Database,
  ctx: TenantContext,
  id: string,
  input: unknown,
): Promise<{ studentId: string; admissionNumber: string; fees: number }> {
  assertAllowed(ctx, "admissions.manage");
  assertAllowed(ctx, "students.manage");
  const data = z.object({ classId: z.preprocess(blank, z.string().uuid().optional()) }).parse(input ?? {});
  return withTenant(database, scope(ctx), async (tx) => {
    const app = await loadForUpdate(tx, ctx, id);
    if (app.status === "enrolled" && app.studentId) {
      const [s] = await tx
        .select({ admissionNumber: students.admissionNumber })
        .from(students)
        .where(eq(students.id, app.studentId));
      return { studentId: app.studentId, admissionNumber: s!.admissionNumber, fees: 0 };
    }
    if (app.status !== "offered") throw new DomainError("move_invalid", "Make an offer before enrolling.");
    if (!app.entryTermId) throw new DomainError("term_invalid", "The offer has no entry term.");
    const classId = data.classId ?? app.offerClassId;
    if (!classId) throw new DomainError("class_invalid", "Choose the class the child joins.", "classId");
    await assertClassForLevel(tx, ctx, classId, app.levelId);
    if (!app.sex)
      throw new DomainError("sex_missing", "Record the child's sex on the application before enrolling.");
    await assertStudentCapacity(tx, ctx.tenant.id, 1);
    const admissionNumber = await nextAdmissionNumber(tx, ctx.tenant.id);
    const today = todayIn(ctx.tenant.timezone);
    const [student] = await tx
      .insert(students)
      .values({
        tenantId: ctx.tenant.id,
        admissionNumber,
        firstName: app.childFirstName!,
        otherNames: app.childOtherNames,
        lastName: app.childLastName!,
        sex: app.sex,
        dateOfBirth: app.dateOfBirth,
        admittedOn: today,
      })
      .returning({ id: students.id });
    await tx
      .insert(enrolments)
      .values({ tenantId: ctx.tenant.id, studentId: student!.id, termId: app.entryTermId, classId });
    await linkGuardianInTx(tx, ctx, student!.id, {
      fullName: app.guardianName!,
      phone: app.guardianPhone,
      email: app.guardianEmail,
      relationship: (app.guardianRelationship ?? "guardian") as (typeof RELATIONSHIPS)[number],
      isPrimary: true,
    });
    const fees = app.offerFees ?? [];
    for (const [i, fee] of fees.entries())
      await tx.insert(ledgerEntries).values({
        tenantId: ctx.tenant.id,
        studentId: student!.id,
        termId: app.entryTermId,
        kind: "charge",
        description: fee.description,
        amountPesewas: fee.amountPesewas,
        billingKey: `admission:${app.id}:${i + 1}`,
        effectiveOn: today,
        recordedByUserId: ctx.userId,
      });
    await tx
      .update(applications)
      .set({ status: "enrolled", studentId: student!.id, closedAt: new Date(), updatedAt: new Date() })
      .where(eq(applications.id, app.id));
    await addEvent(tx, ctx, app, "enrolled", `Admission number ${admissionNumber}`);
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "student.created",
      entityType: "student",
      entityId: student!.id,
      metadata: { admissionNumber, fromApplication: app.reference, admissionFees: fees.length },
    });
    return { studentId: student!.id, admissionNumber, fees: fees.length };
  });
}

// ——— Reporting (ADM-08) ———

export interface FunnelRow {
  key: string;
  label: string;
  total: number;
  applied: number;
  offered: number;
  enrolled: number;
  declined: number;
  withdrawn: number;
}

/**
 * How applicants moved through the pipeline, by level and by source: how many reached each stage (from the
 * history, so an applicant later withdrawn still counts as offered if they were). Optionally for one entry term.
 */
export async function getAdmissionsReport(
  database: Database,
  ctx: TenantContext,
  input: unknown = {},
): Promise<{ byLevel: FunnelRow[]; bySource: FunnelRow[] }> {
  assertAllowed(ctx, "admissions.view");
  const { termId } = z.object({ termId: z.preprocess(blank, z.string().uuid().optional()) }).parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    const reached = (status: ApplicationStatus) =>
      sql<boolean>`exists (select 1 from ${applicationEvents} e where e.application_id = ${applications.id} and e.to_status = ${status})`;
    const rows = await tx
      .select({
        levelId: levels.id,
        levelName: levels.name,
        sequence: levels.sequence,
        source: applications.source,
        status: applications.status,
        applied: reached("applied"),
        offered: reached("offered"),
      })
      .from(applications)
      .innerJoin(levels, eq(levels.id, applications.levelId))
      .where(
        and(
          eq(applications.tenantId, ctx.tenant.id),
          ...(termId ? [eq(applications.entryTermId, termId)] : []),
        ),
      );
    const group = (
      key: (r: (typeof rows)[number]) => string,
      label: (r: (typeof rows)[number]) => string,
    ) => {
      const map = new Map<string, FunnelRow>();
      for (const r of rows) {
        const k = key(r);
        const row = map.get(k) ?? {
          key: k,
          label: label(r),
          total: 0,
          applied: 0,
          offered: 0,
          enrolled: 0,
          declined: 0,
          withdrawn: 0,
        };
        row.total++;
        if (r.applied) row.applied++;
        if (r.offered) row.offered++;
        if (r.status === "enrolled") row.enrolled++;
        if (r.status === "declined") row.declined++;
        if (r.status === "withdrawn") row.withdrawn++;
        map.set(k, row);
      }
      return [...map.values()];
    };
    const order = new Map(rows.map((r) => [r.levelId, r.sequence]));
    return {
      byLevel: group(
        (r) => r.levelId,
        (r) => r.levelName,
      ).sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0)),
      bySource: group(
        (r) => r.source,
        (r) => r.source,
      ).sort((a, b) => b.total - a.total),
    };
  });
}

// ——— Retention (D-R3-2) ———

/**
 * Removes personal details from declined and withdrawn applications closed more than 12 months ago: names,
 * date of birth, previous school, contact, notes and assessment notes. What remains (reference, level, term,
 * source, dates, history) keeps the admissions reports correct. Enrolled applications are kept: the student
 * record took over. Runs from the worker; returns how many were erased.
 */
export async function eraseExpiredApplications(database: Database, now = new Date()): Promise<number> {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - APPLICATION_RETENTION_MONTHS);
  const schools = await database.select({ id: tenants.id }).from(tenants);
  let erased = 0;
  for (const school of schools) {
    erased += await withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => {
      const rows = await tx
        .update(applications)
        .set({
          childFirstName: null,
          childOtherNames: null,
          childLastName: null,
          dateOfBirth: null,
          previousSchool: null,
          guardianName: null,
          guardianPhone: null,
          guardianEmail: null,
          notes: null,
          assessmentNote: null,
          erasedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(applications.tenantId, school.id),
            inArray(applications.status, ["declined", "withdrawn"]),
            isNull(applications.erasedAt),
            lt(applications.closedAt, cutoff),
          ),
        )
        .returning({ id: applications.id, reference: applications.reference });
      if (rows.length)
        await recordAudit(tx, {
          tenantId: school.id,
          actorUserId: null,
          action: "applications.erased",
          entityType: "tenant",
          entityId: school.id,
          metadata: { count: rows.length, references: rows.map((r) => r.reference) },
        });
      return rows.length;
    });
  }
  return erased;
}
