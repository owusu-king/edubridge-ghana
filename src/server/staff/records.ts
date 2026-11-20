import "server-only";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { todayIn } from "../../lib/format";
import { normalizePhone } from "../../lib/phone";
import {
  EMPLOYMENT_TYPES,
  formatStaffNumber,
  type EmploymentEventKind,
  type EmploymentType,
} from "../../lib/staff";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  campuses,
  classes,
  memberships,
  staff,
  staffDepartments,
  staffEmploymentEvents,
  staffPositions,
  subjectTeachers,
  subjects,
  tenantCounters,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import { listFiles, markRemoved, readStoredFile, storeFile } from "../files/service";
import type { TenantContext } from "../tenancy/service";

/**
 * Staff records (HR-01, HR-02; module staff_hr). A staff record is a person who works at the school, with or
 * without an EduBridge account. Personal details are corrected in place (audited); employment changes are
 * insert-only events with an effective date, and the record holds the current state. Campus scope applies:
 * staff limited to some campuses see and change only staff at those campuses (or at none).
 */

export const scopeOf = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

const UUID = z.string().uuid();
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const optionalText = (max: number) =>
  z.preprocess(blank, z.string().trim().max(max, `Use ${max} characters or fewer.`).nullable().optional());
const isoDate = (message: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, message);

/** Staff the context can see: every campus, or its campuses and staff with no campus. */
function visible(ctx: TenantContext) {
  const own = eq(staff.tenantId, ctx.tenant.id);
  if (ctx.campusIds === null) return own;
  return and(own, or(isNull(staff.campusId), inArray(staff.campusId, ctx.campusIds)));
}

function assertCampus(ctx: TenantContext, campusId: string | null) {
  if (campusId && ctx.campusIds !== null && !ctx.campusIds.includes(campusId))
    throw new DomainError("campus_scope", "You can only add staff at your campuses.", "campusId");
}

// ——— Departments and positions (HR-02) ———

export type StaffListKind = "department" | "position";
const LIST_TABLE = { department: staffDepartments, position: staffPositions } as const;

export interface NamedItem {
  id: string;
  name: string;
  archived: boolean;
}

export async function listStaffLists(
  database: Database,
  ctx: TenantContext,
): Promise<{ departments: NamedItem[]; positions: NamedItem[] }> {
  assertAllowed(ctx, "staff.view");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const read = async (kind: StaffListKind) => {
      const t = LIST_TABLE[kind];
      const rows = await tx
        .select({ id: t.id, name: t.name, archivedAt: t.archivedAt })
        .from(t)
        .where(eq(t.tenantId, ctx.tenant.id))
        .orderBy(asc(t.name));
      return rows.map((r) => ({ id: r.id, name: r.name, archived: r.archivedAt !== null }));
    };
    return { departments: await read("department"), positions: await read("position") };
  });
}

const nameSchema = z.object({
  name: z.string().trim().min(2, "Use at least 2 characters.").max(80, "Use 80 characters or fewer."),
});

export async function addStaffListItem(
  database: Database,
  ctx: TenantContext,
  kind: StaffListKind,
  input: unknown,
): Promise<string> {
  assertAllowed(ctx, "staff.manage");
  const { name } = nameSchema.parse(input);
  const t = LIST_TABLE[kind];
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .insert(t)
      .values({ tenantId: ctx.tenant.id, name })
      .onConflictDoNothing()
      .returning({ id: t.id });
    if (!row) throw new DomainError("name_taken", `There is already a ${kind} called ${name}.`, "name");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: `staff.${kind}_added`,
      entityType: `staff_${kind}`,
      entityId: row.id,
      metadata: { name },
    });
    return row.id;
  });
}

export async function setStaffListItemArchived(
  database: Database,
  ctx: TenantContext,
  kind: StaffListKind,
  id: string,
  archived: boolean,
): Promise<void> {
  assertAllowed(ctx, "staff.manage");
  if (!UUID.safeParse(id).success) throw new DomainError("not_found", "Not found.");
  const t = LIST_TABLE[kind];
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const updated = await tx
      .update(t)
      .set({ archivedAt: archived ? new Date() : null })
      .where(and(eq(t.tenantId, ctx.tenant.id), eq(t.id, id)))
      .returning({ name: t.name });
    if (!updated.length) throw new DomainError("not_found", "Not found.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: archived ? `staff.${kind}_archived` : `staff.${kind}_restored`,
      entityType: `staff_${kind}`,
      entityId: id,
      metadata: { name: updated[0]!.name },
    });
  });
}

// ——— Staff records (HR-01) ———

export interface StaffSummary {
  id: string;
  staffNumber: string;
  name: string;
  position: string | null;
  department: string | null;
  campus: string | null;
  employmentType: EmploymentType;
  status: "active" | "left";
  phone: string | null;
  hasAccount: boolean;
}

const fullName = (r: { firstName: string; otherNames: string | null; lastName: string }) =>
  [r.firstName, r.otherNames, r.lastName].filter(Boolean).join(" ");

export async function listStaff(
  database: Database,
  ctx: TenantContext,
  filter: { status?: "active" | "left" | "all"; q?: string } = {},
): Promise<StaffSummary[]> {
  assertAllowed(ctx, "staff.view");
  const status = filter.status ?? "active";
  const q = filter.q?.trim().slice(0, 80) ?? "";
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const rows = await tx
      .select({
        s: staff,
        position: staffPositions.name,
        department: staffDepartments.name,
        campus: campuses.name,
      })
      .from(staff)
      .leftJoin(staffPositions, eq(staffPositions.id, staff.positionId))
      .leftJoin(staffDepartments, eq(staffDepartments.id, staff.departmentId))
      .leftJoin(campuses, eq(campuses.id, staff.campusId))
      .where(
        and(
          visible(ctx),
          status === "all" ? undefined : eq(staff.status, status),
          q
            ? sql`(${staff.firstName} || ' ' || coalesce(${staff.otherNames}, '') || ' ' || ${staff.lastName} || ' ' || ${staff.staffNumber}) ilike ${`%${q}%`}`
            : undefined,
        ),
      )
      .orderBy(asc(staff.lastName), asc(staff.firstName))
      .limit(1000);
    return rows.map(({ s, position, department, campus }) => ({
      id: s.id,
      staffNumber: s.staffNumber,
      name: fullName(s),
      position,
      department,
      campus,
      employmentType: s.employmentType,
      status: s.status,
      phone: s.phone,
      hasAccount: s.membershipId !== null,
    }));
  });
}

const detailsSchema = (country: string) =>
  z.object({
    firstName: z.string().trim().min(1, "Enter the first name.").max(80, "Use 80 characters or fewer."),
    lastName: z.string().trim().min(1, "Enter the surname.").max(80, "Use 80 characters or fewer."),
    otherNames: optionalText(80),
    sex: z.preprocess(blank, z.enum(["female", "male"]).nullable().optional()),
    dateOfBirth: z.preprocess(blank, isoDate("Choose a date.").nullable().optional()),
    phone: z.preprocess(
      blank,
      z
        .string()
        .transform((v, c) => {
          const phone = normalizePhone(v, country);
          if (!phone) c.addIssue({ code: "custom", message: "Enter a valid phone number." });
          return phone ?? "";
        })
        .nullable()
        .optional(),
    ),
    email: z.preprocess(
      blank,
      z.string().trim().email("Enter a valid email.").max(200).nullable().optional(),
    ),
    address: optionalText(300),
    qualifications: optionalText(500),
    emergencyName: optionalText(120),
    emergencyRelationship: optionalText(60),
    emergencyPhone: z.preprocess(
      blank,
      z
        .string()
        .transform((v, c) => {
          const phone = normalizePhone(v, country);
          if (!phone) c.addIssue({ code: "custom", message: "Enter a valid phone number." });
          return phone ?? "";
        })
        .nullable()
        .optional(),
    ),
  });

const employmentSchema = z.object({
  employmentType: z.enum(EMPLOYMENT_TYPES, { message: "Choose the type of employment." }),
  departmentId: z.preprocess(blank, UUID.nullable().optional()),
  positionId: z.preprocess(blank, UUID.nullable().optional()),
  campusId: z.preprocess(blank, UUID.nullable().optional()),
});

const createSchema = (country: string) =>
  detailsSchema(country)
    .merge(employmentSchema)
    .extend({ startedOn: isoDate("Choose the start date.") });

async function assertListItems(
  tx: Transaction,
  tenantId: string,
  input: { departmentId?: string | null; positionId?: string | null; campusId?: string | null },
) {
  const check = async (table: typeof staffDepartments | typeof staffPositions, id: string, field: string) => {
    const [row] = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.tenantId, tenantId), eq(table.id, id), isNull(table.archivedAt)));
    if (!row) throw new DomainError("not_found", "Choose one from the list.", field);
  };
  if (input.departmentId) await check(staffDepartments, input.departmentId, "departmentId");
  if (input.positionId) await check(staffPositions, input.positionId, "positionId");
  if (input.campusId) {
    const [row] = await tx
      .select({ id: campuses.id })
      .from(campuses)
      .where(
        and(eq(campuses.tenantId, tenantId), eq(campuses.id, input.campusId), eq(campuses.status, "active")),
      );
    if (!row) throw new DomainError("not_found", "Choose an active campus.", "campusId");
  }
}

async function nextStaffNumber(tx: Transaction, tenantId: string): Promise<string> {
  for (;;) {
    const [row] = await tx
      .insert(tenantCounters)
      .values({ tenantId, key: "staff_number", value: 1 })
      .onConflictDoUpdate({
        target: [tenantCounters.tenantId, tenantCounters.key],
        set: { value: sql`${tenantCounters.value} + 1` },
      })
      .returning({ value: tenantCounters.value });
    const candidate = formatStaffNumber(row!.value);
    const [taken] = await tx
      .select({ id: staff.id })
      .from(staff)
      .where(and(eq(staff.tenantId, tenantId), eq(staff.staffNumber, candidate)));
    if (!taken) return candidate;
  }
}

async function addEvent(
  tx: Transaction,
  ctx: TenantContext,
  staffId: string,
  kind: EmploymentEventKind,
  effectiveOn: string,
  employment: {
    employmentType: EmploymentType;
    departmentId: string | null;
    positionId: string | null;
    campusId: string | null;
  },
  note: string | null,
) {
  await tx.insert(staffEmploymentEvents).values({
    tenantId: ctx.tenant.id,
    staffId,
    kind,
    effectiveOn,
    ...employment,
    note,
    recordedByUserId: ctx.userId,
  });
}

/** A staff record ready to insert: personal details, employment and start date (checked by the caller). */
export interface NewStaff {
  /** Kept from the school's old records when given; otherwise the next staff number. */
  staffNumber?: string | null;
  firstName: string;
  lastName: string;
  otherNames?: string | null;
  sex?: "female" | "male" | null;
  dateOfBirth?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  qualifications?: string | null;
  emergencyName?: string | null;
  emergencyRelationship?: string | null;
  emergencyPhone?: string | null;
  employmentType: EmploymentType;
  departmentId?: string | null;
  positionId?: string | null;
  campusId?: string | null;
  startedOn: string;
}

/**
 * Inserts a staff record and its "started" employment event in the caller's transaction (used by adding one person
 * and by the spreadsheet import, so both make the same record). The caller audits.
 */
export async function insertStaffInTx(
  tx: Transaction,
  ctx: TenantContext,
  data: NewStaff,
): Promise<{ id: string; staffNumber: string }> {
  const employment = {
    employmentType: data.employmentType,
    departmentId: data.departmentId ?? null,
    positionId: data.positionId ?? null,
    campusId: data.campusId ?? null,
  };
  const [row] = await tx
    .insert(staff)
    .values({
      tenantId: ctx.tenant.id,
      staffNumber: data.staffNumber || (await nextStaffNumber(tx, ctx.tenant.id)),
      firstName: data.firstName,
      lastName: data.lastName,
      otherNames: data.otherNames ?? null,
      sex: data.sex ?? null,
      dateOfBirth: data.dateOfBirth ?? null,
      phone: data.phone ?? null,
      email: data.email ?? null,
      address: data.address ?? null,
      qualifications: data.qualifications ?? null,
      emergencyName: data.emergencyName ?? null,
      emergencyRelationship: data.emergencyRelationship ?? null,
      emergencyPhone: data.emergencyPhone ?? null,
      ...employment,
      startedOn: data.startedOn,
    })
    .returning({ id: staff.id, staffNumber: staff.staffNumber });
  await addEvent(tx, ctx, row!.id, "started", data.startedOn, employment, null);
  return row!;
}

/** Adds a staff record with the next staff number, and its "started" employment event. */
export async function createStaff(database: Database, ctx: TenantContext, input: unknown): Promise<string> {
  assertAllowed(ctx, "staff.manage");
  const data = createSchema(ctx.tenant.countryCode).parse(input);
  assertCampus(ctx, data.campusId ?? null);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    await assertListItems(tx, ctx.tenant.id, data);
    const row = await insertStaffInTx(tx, ctx, { ...data, staffNumber: null });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "staff.added",
      entityType: "staff",
      entityId: row.id,
      metadata: { staffNumber: row.staffNumber, name: `${data.firstName} ${data.lastName}` },
    });
    return row.id;
  });
}

async function readVisible(tx: Transaction, ctx: TenantContext, staffId: string) {
  if (!UUID.safeParse(staffId).success) throw new DomainError("not_found", "Staff member not found.");
  const [row] = await tx
    .select()
    .from(staff)
    .where(and(visible(ctx), eq(staff.id, staffId)))
    .for("update");
  if (!row) throw new DomainError("not_found", "Staff member not found.");
  return row;
}

/** Corrects personal details (HR-01b). Every change is audited with the fields that changed. */
export async function updateStaffDetails(
  database: Database,
  ctx: TenantContext,
  staffId: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "staff.manage");
  const data = detailsSchema(ctx.tenant.countryCode).parse(input);
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const before = await readVisible(tx, ctx, staffId);
    const next = {
      firstName: data.firstName,
      lastName: data.lastName,
      otherNames: data.otherNames ?? null,
      sex: data.sex ?? null,
      dateOfBirth: data.dateOfBirth ?? null,
      phone: data.phone ?? null,
      email: data.email ?? null,
      address: data.address ?? null,
      qualifications: data.qualifications ?? null,
      emergencyName: data.emergencyName ?? null,
      emergencyRelationship: data.emergencyRelationship ?? null,
      emergencyPhone: data.emergencyPhone ?? null,
    };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => before[k] !== next[k]);
    if (!changed.length) return;
    await tx
      .update(staff)
      .set({ ...next, updatedAt: new Date() })
      .where(eq(staff.id, staffId));
    // Field names only: personal values are not copied into the audit log.
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "staff.details_updated",
      entityType: "staff",
      entityId: staffId,
      metadata: { fields: changed },
    });
  });
}

const changeSchema = employmentSchema.extend({
  kind: z.enum(["changed", "left", "returned"]),
  effectiveOn: isoDate("Choose the date it takes effect."),
  note: optionalText(300),
});

/**
 * An employment change (HR-01c): a new type, department, position or campus; leaving (with a reason); or
 * returning. Recorded as an insert-only event; the record shows the latest state.
 */
export async function changeEmployment(
  database: Database,
  ctx: TenantContext,
  staffId: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "staff.manage");
  const data = changeSchema.parse(input);
  if (data.kind === "left" && !data.note)
    throw new DomainError("reason_required", "Say why they left, for the record.", "note");
  assertCampus(ctx, data.campusId ?? null);
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const before = await readVisible(tx, ctx, staffId);
    if (data.kind === "left" && before.status === "left")
      throw new DomainError("already_left", "This person has already left.");
    if (data.kind === "returned" && before.status !== "left")
      throw new DomainError("not_left", "Only someone who left can return.");
    if (data.kind === "changed" && before.status === "left")
      throw new DomainError("already_left", "Record their return first.");
    if (data.effectiveOn < before.startedOn)
      throw new DomainError("date_invalid", "The date is before they started.", "effectiveOn");
    const employment =
      data.kind === "left"
        ? {
            employmentType: before.employmentType,
            departmentId: before.departmentId,
            positionId: before.positionId,
            campusId: before.campusId,
          }
        : {
            employmentType: data.employmentType,
            departmentId: data.departmentId ?? null,
            positionId: data.positionId ?? null,
            campusId: data.campusId ?? null,
          };
    if (data.kind !== "left") await assertListItems(tx, ctx.tenant.id, employment);
    await tx
      .update(staff)
      .set({
        ...employment,
        status: data.kind === "left" ? "left" : "active",
        leftOn: data.kind === "left" ? data.effectiveOn : null,
        leavingReason: data.kind === "left" ? (data.note ?? null) : null,
        updatedAt: new Date(),
      })
      .where(eq(staff.id, staffId));
    await addEvent(tx, ctx, staffId, data.kind, data.effectiveOn, employment, data.note ?? null);
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: `staff.employment_${data.kind}`,
      entityType: "staff",
      entityId: staffId,
      metadata: { effectiveOn: data.effectiveOn, ...employment },
    });
  });
}

/** Links a staff record to a member's EduBridge account at this school (once per member), or unlinks it. */
export async function linkStaffMember(
  database: Database,
  ctx: TenantContext,
  staffId: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "staff.manage");
  const { membershipId } = z.object({ membershipId: z.preprocess(blank, UUID.nullable()) }).parse(input);
  await withTenant(database, scopeOf(ctx), async (tx) => {
    await readVisible(tx, ctx, staffId);
    if (membershipId) {
      const [member] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.tenantId, ctx.tenant.id), eq(memberships.id, membershipId)));
      if (!member) throw new DomainError("not_found", "Choose a member of this school.", "membershipId");
      const [other] = await tx
        .select({ id: staff.id })
        .from(staff)
        .where(and(eq(staff.tenantId, ctx.tenant.id), eq(staff.membershipId, membershipId)));
      if (other && other.id !== staffId)
        throw new DomainError("member_linked", "That member already has a staff record.", "membershipId");
    }
    await tx.update(staff).set({ membershipId, updatedAt: new Date() }).where(eq(staff.id, staffId));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: membershipId ? "staff.member_linked" : "staff.member_unlinked",
      entityType: "staff",
      entityId: staffId,
      metadata: { membershipId },
    });
  });
}

export interface StaffDetail {
  record: typeof staff.$inferSelect;
  name: string;
  position: string | null;
  department: string | null;
  campus: string | null;
  account: { name: string; email: string } | null;
  history: {
    kind: EmploymentEventKind;
    effectiveOn: string;
    employmentType: EmploymentType;
    position: string | null;
    department: string | null;
    campus: string | null;
    note: string | null;
    recordedBy: string;
    recordedAt: Date;
  }[];
  /** What the linked member teaches, from the classes and subject records (HR-02; never copied). */
  teaching: { classTeacherOf: string[]; subjects: { subject: string; className: string }[] };
  documents: Awaited<ReturnType<typeof listFiles>> | null;
}

export async function getStaff(
  database: Database,
  ctx: TenantContext,
  staffId: string,
): Promise<StaffDetail> {
  assertAllowed(ctx, "staff.view");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    if (!UUID.safeParse(staffId).success) throw new DomainError("not_found", "Staff member not found.");
    const [row] = await tx
      .select({
        s: staff,
        position: staffPositions.name,
        department: staffDepartments.name,
        campus: campuses.name,
        accountName: users.name,
        accountEmail: users.email,
      })
      .from(staff)
      .leftJoin(staffPositions, eq(staffPositions.id, staff.positionId))
      .leftJoin(staffDepartments, eq(staffDepartments.id, staff.departmentId))
      .leftJoin(campuses, eq(campuses.id, staff.campusId))
      .leftJoin(memberships, eq(memberships.id, staff.membershipId))
      .leftJoin(users, eq(users.id, memberships.userId))
      .where(and(visible(ctx), eq(staff.id, staffId)));
    if (!row) throw new DomainError("not_found", "Staff member not found.");
    const events = await tx
      .select({
        e: staffEmploymentEvents,
        position: staffPositions.name,
        department: staffDepartments.name,
        campus: campuses.name,
        by: users.name,
      })
      .from(staffEmploymentEvents)
      .leftJoin(staffPositions, eq(staffPositions.id, staffEmploymentEvents.positionId))
      .leftJoin(staffDepartments, eq(staffDepartments.id, staffEmploymentEvents.departmentId))
      .leftJoin(campuses, eq(campuses.id, staffEmploymentEvents.campusId))
      .innerJoin(users, eq(users.id, staffEmploymentEvents.recordedByUserId))
      .where(
        and(eq(staffEmploymentEvents.tenantId, ctx.tenant.id), eq(staffEmploymentEvents.staffId, staffId)),
      )
      .orderBy(desc(staffEmploymentEvents.effectiveOn), desc(staffEmploymentEvents.recordedAt));
    let teaching: StaffDetail["teaching"] = { classTeacherOf: [], subjects: [] };
    if (row.s.membershipId) {
      const own = await tx
        .select({ name: classes.name })
        .from(classes)
        .where(
          and(
            eq(classes.tenantId, ctx.tenant.id),
            eq(classes.classTeacherMembershipId, row.s.membershipId),
            eq(classes.status, "active"),
          ),
        )
        .orderBy(asc(classes.name));
      const taught = await tx
        .select({ subject: subjects.name, className: classes.name })
        .from(subjectTeachers)
        .innerJoin(subjects, eq(subjects.id, subjectTeachers.subjectId))
        .innerJoin(classes, eq(classes.id, subjectTeachers.classId))
        .where(
          and(
            eq(subjectTeachers.tenantId, ctx.tenant.id),
            eq(subjectTeachers.membershipId, row.s.membershipId),
          ),
        )
        .orderBy(asc(classes.name), asc(subjects.name));
      teaching = { classTeacherOf: own.map((c) => c.name), subjects: taught };
    }
    return {
      record: row.s,
      name: fullName(row.s),
      position: row.position,
      department: row.department,
      campus: row.campus,
      account:
        row.accountName && row.accountEmail ? { name: row.accountName, email: row.accountEmail } : null,
      history: events.map(({ e, position, department, campus, by }) => ({
        kind: e.kind,
        effectiveOn: e.effectiveOn,
        employmentType: e.employmentType,
        position,
        department,
        campus,
        note: e.note,
        recordedBy: by,
        recordedAt: e.recordedAt,
      })),
      teaching,
      documents: allowed(ctx, "staff.documents")
        ? await listFiles(tx, ctx.tenant.id, "staff_document", staffId)
        : null,
    };
  });
}

/** Members of the school without a staff record yet, to link one (staff.manage). */
export async function listLinkableMembers(
  database: Database,
  ctx: TenantContext,
): Promise<{ id: string; name: string; email: string }[]> {
  assertAllowed(ctx, "staff.manage");
  return withTenant(database, scopeOf(ctx), (tx) =>
    tx
      .select({ id: memberships.id, name: users.name, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.tenantId, ctx.tenant.id),
          eq(memberships.status, "active"),
          sql`not exists (select 1 from staff s where s.tenant_id = ${ctx.tenant.id} and s.membership_id = ${memberships.id})`,
        ),
      )
      .orderBy(asc(users.name)),
  );
}

/** The signed-in member's own staff record at this school, if any. */
export async function readOwnStaff(tx: Transaction, ctx: TenantContext) {
  const [row] = await tx
    .select({ id: staff.id, firstName: staff.firstName, lastName: staff.lastName, status: staff.status })
    .from(staff)
    .innerJoin(memberships, eq(memberships.id, staff.membershipId))
    .where(and(eq(staff.tenantId, ctx.tenant.id), eq(memberships.userId, ctx.userId)));
  return row ?? null;
}

// ——— Documents (HR-01d) ———

export async function uploadStaffDocument(
  database: Database,
  ctx: TenantContext,
  staffId: string,
  file: { filename: string; bytes: Buffer },
): Promise<string> {
  assertAllowed(ctx, "staff.documents");
  assertAllowed(ctx, "staff.manage");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    await readVisible(tx, ctx, staffId);
    const id = await storeFile(tx, ctx, { purpose: "staff_document", ownerId: staffId, ...file });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "staff.document_added",
      entityType: "staff",
      entityId: staffId,
      metadata: { fileId: id, filename: file.filename.slice(0, 120) },
    });
    return id;
  });
}

/** A staff document; every download is recorded in the audit log. Allowed while the module is read-only. */
export async function downloadStaffDocument(
  database: Database,
  ctx: TenantContext,
  staffId: string,
  fileId: string,
) {
  assertAllowed(ctx, "staff.documents");
  if (!UUID.safeParse(fileId).success || !UUID.safeParse(staffId).success) return null;
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [own] = await tx
      .select({ id: staff.id })
      .from(staff)
      .where(and(visible(ctx), eq(staff.id, staffId)));
    if (!own) return null;
    const file = await readStoredFile(tx, ctx.tenant.id, fileId, "staff_document");
    if (!file || file.ownerId !== staffId) return null;
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "staff.document_downloaded",
      entityType: "staff",
      entityId: staffId,
      metadata: { fileId, filename: file.filename },
    });
    return file;
  });
}

export async function removeStaffDocument(
  database: Database,
  ctx: TenantContext,
  staffId: string,
  fileId: string,
): Promise<void> {
  assertAllowed(ctx, "staff.documents");
  assertAllowed(ctx, "staff.manage");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    await readVisible(tx, ctx, staffId);
    const removed = await markRemoved(tx, ctx, fileId, "staff_document");
    if (!removed || removed.ownerId !== staffId) throw new DomainError("not_found", "Document not found.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "staff.document_removed",
      entityType: "staff",
      entityId: staffId,
      metadata: { fileId, filename: removed.filename },
    });
  });
}

export const todayFor = (ctx: TenantContext) => todayIn(ctx.tenant.timezone);
