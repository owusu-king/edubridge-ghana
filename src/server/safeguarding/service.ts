import "server-only";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  CASE_STATUSES,
  CONCERN_CATEGORIES,
  WRITTEN_ENTRY_KINDS,
  formatCaseReference,
  type CaseStatus,
  type ConcernCategory,
  type EntryKind,
} from "../../lib/safeguarding";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  classes,
  enrolments,
  memberships,
  safeguardingAccess,
  safeguardingCases,
  safeguardingDocuments,
  safeguardingEntries,
  safeguardingLeads,
  students,
  tenantCounters,
  terms,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import { checkFile } from "../files/service";
import type { TenantContext } from "../tenancy/service";

/**
 * Safeguarding (R4-3; module safeguarding, in every plan). Any staff member reports a concern; only the school's
 * designated safeguarding leads, appointed by the Proprietor, read and handle cases. The database enforces the
 * same rule (row-level security through app_is_safeguarding_lead), so a mistake here cannot show a case to anyone
 * else, and contexts without a user (jobs, insights, the assistant) see nothing. Case content is kept out of the
 * general audit log, which other staff can read: the case's own insert-only history and access record are its
 * audit trail (SFG-01f).
 */

const UUID = z.string().uuid();
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
const optionalText = (max: number) =>
  z.preprocess(blank, z.string().trim().max(max, `Use ${max} characters or fewer.`).nullable().optional());

const scopeOf = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

const notFound = () => new DomainError("not_found", "Case not found.");

// ——— Leads (SFG-01b) ———

export interface Lead {
  id: string;
  membershipId: string;
  name: string;
  email: string;
  since: Date;
}

async function readLeads(tx: Transaction, tenantId: string): Promise<Lead[]> {
  return tx
    .select({
      id: safeguardingLeads.id,
      membershipId: safeguardingLeads.membershipId,
      name: users.name,
      email: users.email,
      since: safeguardingLeads.grantedAt,
    })
    .from(safeguardingLeads)
    .innerJoin(memberships, eq(memberships.id, safeguardingLeads.membershipId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(safeguardingLeads.tenantId, tenantId),
        isNull(safeguardingLeads.endedAt),
        eq(memberships.status, "active"),
      ),
    )
    .orderBy(asc(users.name));
}

/** Who the school's leads are: every staff member may know who to go to. */
export async function listLeads(database: Database, ctx: TenantContext): Promise<Lead[]> {
  if (!allowed(ctx, "safeguarding.appoint")) assertAllowed(ctx, "safeguarding.report");
  return withTenant(database, scopeOf(ctx), (tx) => readLeads(tx, ctx.tenant.id));
}

/** Members who can be appointed (active staff not already leads), for the Proprietor. */
export async function listAppointableMembers(
  database: Database,
  ctx: TenantContext,
): Promise<{ id: string; name: string; email: string }[]> {
  assertAllowed(ctx, "safeguarding.appoint");
  return withTenant(database, scopeOf(ctx), (tx) =>
    tx
      .select({ id: memberships.id, name: users.name, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.tenantId, ctx.tenant.id),
          eq(memberships.status, "active"),
          sql`${memberships.roles} && ARRAY['owner','headteacher','admin','bursar','teacher']::text[]`,
          sql`not exists (select 1 from safeguarding_leads l where l.tenant_id = ${ctx.tenant.id} and l.membership_id = ${memberships.id} and l.ended_at is null)`,
        ),
      )
      .orderBy(asc(users.name)),
  );
}

export async function appointLead(
  database: Database,
  ctx: TenantContext,
  membershipId: string,
): Promise<void> {
  assertAllowed(ctx, "safeguarding.appoint");
  if (!UUID.safeParse(membershipId).success)
    throw new DomainError("not_found", "Choose a member.", "membershipId");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [member] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, ctx.tenant.id),
          eq(memberships.id, membershipId),
          eq(memberships.status, "active"),
        ),
      );
    if (!member) throw new DomainError("not_found", "Choose an active member of staff.", "membershipId");
    const inserted = await tx
      .insert(safeguardingLeads)
      .values({ tenantId: ctx.tenant.id, membershipId, grantedByUserId: ctx.userId })
      .onConflictDoNothing()
      .returning({ id: safeguardingLeads.id });
    if (!inserted.length) return;
    // Who leads is not case content: it is recorded in the school's audit log.
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "safeguarding.lead_appointed",
      entityType: "membership",
      entityId: membershipId,
    });
  });
}

export async function endLead(database: Database, ctx: TenantContext, leadId: string): Promise<void> {
  assertAllowed(ctx, "safeguarding.appoint");
  if (!UUID.safeParse(leadId).success) throw new DomainError("not_found", "Lead not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [ended] = await tx
      .update(safeguardingLeads)
      .set({ endedAt: new Date(), endedByUserId: ctx.userId })
      .where(
        and(
          eq(safeguardingLeads.tenantId, ctx.tenant.id),
          eq(safeguardingLeads.id, leadId),
          isNull(safeguardingLeads.endedAt),
        ),
      )
      .returning({ membershipId: safeguardingLeads.membershipId });
    if (!ended) throw new DomainError("not_found", "Lead not found.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "safeguarding.lead_ended",
      entityType: "membership",
      entityId: ended.membershipId,
    });
  });
}

// ——— Reporting (SFG-01a) ———

/**
 * Students a concern can be about: every active student, with this term's class. Staff who see only their own
 * classes elsewhere may still report about any child (a concern can arise anywhere), so this lists names and
 * classes only.
 */
export async function listReportableStudents(
  database: Database,
  ctx: TenantContext,
): Promise<{ id: string; name: string; className: string | null }[]> {
  assertAllowed(ctx, "safeguarding.report");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [term] = await tx
      .select({ id: terms.id })
      .from(terms)
      .where(and(eq(terms.tenantId, ctx.tenant.id), eq(terms.isCurrent, true)));
    const rows = await tx
      .select({
        id: students.id,
        firstName: students.firstName,
        lastName: students.lastName,
        className: classes.name,
      })
      .from(students)
      .leftJoin(
        enrolments,
        and(eq(enrolments.studentId, students.id), term ? eq(enrolments.termId, term.id) : sql`false`),
      )
      .leftJoin(classes, eq(classes.id, enrolments.classId))
      .where(and(eq(students.tenantId, ctx.tenant.id), eq(students.status, "active")))
      .orderBy(asc(classes.name), asc(students.lastName), asc(students.firstName))
      .limit(5000);
    return rows.map((r) => ({ id: r.id, name: `${r.firstName} ${r.lastName}`, className: r.className }));
  });
}

const reportSchema = z.object({
  studentId: UUID,
  category: z.enum(CONCERN_CATEGORIES, { message: "Choose what the concern is about." }),
  description: z
    .string()
    .trim()
    .min(10, "Say what you saw or were told, in a sentence or more.")
    .max(4000, "Use 4,000 characters or fewer."),
  occurredOn: z.preprocess(
    blank,
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.")
      .nullable()
      .optional(),
  ),
  location: optionalText(200),
  immediateAction: optionalText(2000),
});

/** Reports a concern. The account is kept exactly as written; the reporter is told only that it was received. */
export async function reportConcern(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<{ reference: string }> {
  assertAllowed(ctx, "safeguarding.report");
  const data = reportSchema.parse(input);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [student] = await tx
      .select({ id: students.id })
      .from(students)
      .where(and(eq(students.tenantId, ctx.tenant.id), eq(students.id, data.studentId)));
    if (!student) throw new DomainError("not_found", "Choose a student.", "studentId");
    const [counter] = await tx
      .insert(tenantCounters)
      .values({ tenantId: ctx.tenant.id, key: "safeguarding_case", value: 1 })
      .onConflictDoUpdate({
        target: [tenantCounters.tenantId, tenantCounters.key],
        set: { value: sql`${tenantCounters.value} + 1` },
      })
      .returning({ value: tenantCounters.value });
    const reference = formatCaseReference(counter!.value);
    await tx.insert(safeguardingCases).values({
      tenantId: ctx.tenant.id,
      reference,
      studentId: data.studentId,
      category: data.category,
      description: data.description,
      occurredOn: data.occurredOn ?? null,
      location: data.location ?? null,
      immediateAction: data.immediateAction ?? null,
      reportedByUserId: ctx.userId,
    });
    return { reference };
  });
}

/** The signed-in member's own reports: reference, child and when (never what leads have done). */
export async function listMyReports(
  database: Database,
  ctx: TenantContext,
): Promise<{ reference: string; student: string; reportedAt: Date }[]> {
  assertAllowed(ctx, "safeguarding.report");
  return withTenant(database, scopeOf(ctx), (tx) =>
    tx
      .select({
        reference: safeguardingCases.reference,
        student: sql<string>`${students.firstName} || ' ' || ${students.lastName}`,
        reportedAt: safeguardingCases.reportedAt,
      })
      .from(safeguardingCases)
      .innerJoin(students, eq(students.id, safeguardingCases.studentId))
      .where(
        and(
          eq(safeguardingCases.tenantId, ctx.tenant.id),
          eq(safeguardingCases.reportedByUserId, ctx.userId),
        ),
      )
      .orderBy(desc(safeguardingCases.reportedAt))
      .limit(50),
  );
}

// ——— Cases (leads) ———

export interface CaseSummary {
  id: string;
  reference: string;
  student: string;
  category: ConcernCategory;
  status: CaseStatus;
  reportedAt: Date;
  lead: string | null;
  openActions: number;
}

export async function listCases(
  database: Database,
  ctx: TenantContext,
  filter: { status?: CaseStatus | "all" } = {},
): Promise<CaseSummary[]> {
  assertAllowed(ctx, "safeguarding.manage");
  const status = filter.status ?? "all";
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const rows = await tx
      .select({
        c: safeguardingCases,
        student: sql<string>`${students.firstName} || ' ' || ${students.lastName}`,
        lead: users.name,
      })
      .from(safeguardingCases)
      .innerJoin(students, eq(students.id, safeguardingCases.studentId))
      .leftJoin(memberships, eq(memberships.id, safeguardingCases.leadMembershipId))
      .leftJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(safeguardingCases.tenantId, ctx.tenant.id),
          status === "all" ? undefined : eq(safeguardingCases.status, status),
        ),
      )
      .orderBy(
        sql`case ${safeguardingCases.status} when 'open' then 0 when 'monitoring' then 1 else 2 end`,
        desc(safeguardingCases.reportedAt),
      )
      .limit(500);
    const ids = rows.map((r) => r.c.id);
    const open = ids.length
      ? await tx
          .select({ caseId: safeguardingEntries.caseId, n: sql<number>`count(*)::int` })
          .from(safeguardingEntries)
          .where(
            and(
              inArray(safeguardingEntries.caseId, ids),
              eq(safeguardingEntries.kind, "action"),
              isNull(safeguardingEntries.doneAt),
            ),
          )
          .groupBy(safeguardingEntries.caseId)
      : [];
    const openBy = new Map(open.map((o) => [o.caseId, o.n]));
    return rows.map(({ c, student, lead }) => ({
      id: c.id,
      reference: c.reference,
      student,
      category: c.category,
      status: c.status,
      reportedAt: c.reportedAt,
      lead,
      openActions: openBy.get(c.id) ?? 0,
    }));
  });
}

export interface CaseDetail {
  id: string;
  reference: string;
  student: { id: string; name: string; admissionNumber: string };
  category: ConcernCategory;
  description: string;
  occurredOn: string | null;
  location: string | null;
  immediateAction: string | null;
  reportedBy: string;
  reportedAt: Date;
  status: CaseStatus;
  lead: { membershipId: string; name: string } | null;
  entries: {
    id: string;
    kind: EntryKind;
    body: string;
    dueOn: string | null;
    doneAt: Date | null;
    doneBy: string | null;
    by: string;
    at: Date;
  }[];
  documents: { id: string; filename: string; sizeBytes: number; uploadedBy: string; uploadedAt: Date }[];
  access: { user: string; action: "viewed" | "downloaded"; at: Date }[];
  leads: Lead[];
}

async function readCase(tx: Transaction, ctx: TenantContext, caseId: string) {
  if (!UUID.safeParse(caseId).success) throw notFound();
  const [row] = await tx
    .select()
    .from(safeguardingCases)
    .where(and(eq(safeguardingCases.tenantId, ctx.tenant.id), eq(safeguardingCases.id, caseId)))
    .for("update");
  if (!row) throw notFound();
  return row;
}

/** A case for a lead; opening it is recorded (SFG-01d). */
export async function getCase(database: Database, ctx: TenantContext, caseId: string): Promise<CaseDetail> {
  assertAllowed(ctx, "safeguarding.manage");
  if (!UUID.safeParse(caseId).success) throw notFound();
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .select({
        c: safeguardingCases,
        firstName: students.firstName,
        lastName: students.lastName,
        admissionNumber: students.admissionNumber,
        reportedBy: users.name,
      })
      .from(safeguardingCases)
      .innerJoin(students, eq(students.id, safeguardingCases.studentId))
      .innerJoin(users, eq(users.id, safeguardingCases.reportedByUserId))
      .where(and(eq(safeguardingCases.tenantId, ctx.tenant.id), eq(safeguardingCases.id, caseId)));
    if (!row) throw notFound();
    await tx
      .insert(safeguardingAccess)
      .values({ tenantId: ctx.tenant.id, caseId, userId: ctx.userId, action: "viewed" });
    const leads = await readLeads(tx, ctx.tenant.id);
    const doneBy = sql<
      string | null
    >`(select name from users where id = ${safeguardingEntries.doneByUserId})`;
    const entries = await tx
      .select({ e: safeguardingEntries, by: users.name, doneBy })
      .from(safeguardingEntries)
      .innerJoin(users, eq(users.id, safeguardingEntries.createdByUserId))
      .where(and(eq(safeguardingEntries.tenantId, ctx.tenant.id), eq(safeguardingEntries.caseId, caseId)))
      .orderBy(desc(safeguardingEntries.createdAt));
    const documents = await tx
      .select({
        id: safeguardingDocuments.id,
        filename: safeguardingDocuments.filename,
        sizeBytes: safeguardingDocuments.sizeBytes,
        uploadedBy: users.name,
        uploadedAt: safeguardingDocuments.uploadedAt,
      })
      .from(safeguardingDocuments)
      .innerJoin(users, eq(users.id, safeguardingDocuments.uploadedByUserId))
      .where(
        and(
          eq(safeguardingDocuments.tenantId, ctx.tenant.id),
          eq(safeguardingDocuments.caseId, caseId),
          isNull(safeguardingDocuments.removedAt),
        ),
      )
      .orderBy(desc(safeguardingDocuments.uploadedAt));
    const access = await tx
      .select({ user: users.name, action: safeguardingAccess.action, at: safeguardingAccess.at })
      .from(safeguardingAccess)
      .innerJoin(users, eq(users.id, safeguardingAccess.userId))
      .where(and(eq(safeguardingAccess.tenantId, ctx.tenant.id), eq(safeguardingAccess.caseId, caseId)))
      .orderBy(desc(safeguardingAccess.at))
      .limit(100);
    const lead = row.c.leadMembershipId
      ? (leads.find((l) => l.membershipId === row.c.leadMembershipId) ?? null)
      : null;
    return {
      id: row.c.id,
      reference: row.c.reference,
      student: {
        id: row.c.studentId,
        name: `${row.firstName} ${row.lastName}`,
        admissionNumber: row.admissionNumber,
      },
      category: row.c.category,
      description: row.c.description,
      occurredOn: row.c.occurredOn,
      location: row.c.location,
      immediateAction: row.c.immediateAction,
      reportedBy: row.reportedBy,
      reportedAt: row.c.reportedAt,
      status: row.c.status,
      lead: lead ? { membershipId: lead.membershipId, name: lead.name } : null,
      entries: entries.map(({ e, by, doneBy: doneName }) => ({
        id: e.id,
        kind: e.kind,
        body: e.body,
        dueOn: e.dueOn,
        doneAt: e.doneAt,
        doneBy: doneName,
        by,
        at: e.createdAt,
      })),
      documents,
      access,
      leads,
    };
  });
}

const entrySchema = z
  .object({
    kind: z.enum(WRITTEN_ENTRY_KINDS, { message: "Choose what you are recording." }),
    body: z
      .string()
      .trim()
      .min(1, "Write what happened or what is to be done.")
      .max(4000, "Use 4,000 characters or fewer."),
    dueOn: z.preprocess(
      blank,
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.")
        .nullable()
        .optional(),
    ),
  })
  .refine((v) => v.kind === "action" || !v.dueOn, {
    message: "Only an action has a due date.",
    path: ["dueOn"],
  });

async function addEntryInTx(
  tx: Transaction,
  ctx: TenantContext,
  caseId: string,
  entry: { kind: EntryKind; body: string; dueOn?: string | null },
) {
  await tx.insert(safeguardingEntries).values({
    tenantId: ctx.tenant.id,
    caseId,
    kind: entry.kind,
    body: entry.body,
    dueOn: entry.dueOn ?? null,
    createdByUserId: ctx.userId,
  });
  await tx.update(safeguardingCases).set({ updatedAt: new Date() }).where(eq(safeguardingCases.id, caseId));
}

export async function addCaseEntry(
  database: Database,
  ctx: TenantContext,
  caseId: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "safeguarding.manage");
  const data = entrySchema.parse(input);
  await withTenant(database, scopeOf(ctx), async (tx) => {
    await readCase(tx, ctx, caseId);
    await addEntryInTx(tx, ctx, caseId, data);
  });
}

export async function markActionDone(database: Database, ctx: TenantContext, entryId: string): Promise<void> {
  assertAllowed(ctx, "safeguarding.manage");
  if (!UUID.safeParse(entryId).success) throw new DomainError("not_found", "Action not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [done] = await tx
      .update(safeguardingEntries)
      .set({ doneAt: new Date(), doneByUserId: ctx.userId })
      .where(
        and(
          eq(safeguardingEntries.tenantId, ctx.tenant.id),
          eq(safeguardingEntries.id, entryId),
          eq(safeguardingEntries.kind, "action"),
          isNull(safeguardingEntries.doneAt),
        ),
      )
      .returning({ caseId: safeguardingEntries.caseId });
    if (!done) throw new DomainError("action_closed", "This action is already done.");
  });
}

const statusSchema = z
  .object({
    status: z.enum(CASE_STATUSES),
    note: z.preprocess(
      blank,
      z.string().trim().max(2000, "Use 2,000 characters or fewer.").nullable().optional(),
    ),
  })
  .refine((v) => v.status !== "closed" || v.note, { message: "Say why the case is closed.", path: ["note"] });

const STATUS_WORDS: Record<CaseStatus, string> = {
  open: "Reopened",
  monitoring: "Moved to monitoring",
  closed: "Closed",
};

/** Moves a case to monitoring, closes it (with a note) or reopens it; recorded in its history. */
export async function setCaseStatus(
  database: Database,
  ctx: TenantContext,
  caseId: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "safeguarding.manage");
  const data = statusSchema.parse(input);
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const row = await readCase(tx, ctx, caseId);
    if (row.status === data.status) return;
    await tx.update(safeguardingCases).set({ status: data.status }).where(eq(safeguardingCases.id, caseId));
    await addEntryInTx(tx, ctx, caseId, {
      kind: "status",
      body: data.note ? `${STATUS_WORDS[data.status]}: ${data.note}` : STATUS_WORDS[data.status],
    });
  });
}

/** Assigns the lead responsible for a case (an active lead), or none. */
export async function assignCaseLead(
  database: Database,
  ctx: TenantContext,
  caseId: string,
  membershipId: string | null,
): Promise<void> {
  assertAllowed(ctx, "safeguarding.manage");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const row = await readCase(tx, ctx, caseId);
    const leads = await readLeads(tx, ctx.tenant.id);
    const lead = membershipId ? leads.find((l) => l.membershipId === membershipId) : null;
    if (membershipId && !lead)
      throw new DomainError("not_found", "Choose one of the school's leads.", "membershipId");
    if (row.leadMembershipId === (membershipId ?? null)) return;
    await tx
      .update(safeguardingCases)
      .set({ leadMembershipId: membershipId ?? null })
      .where(eq(safeguardingCases.id, caseId));
    await addEntryInTx(tx, ctx, caseId, {
      kind: "assignment",
      body: lead ? `Assigned to ${lead.name}` : "No lead assigned",
    });
  });
}

// ——— Documents (SFG-01e) ———

export async function uploadCaseDocument(
  database: Database,
  ctx: TenantContext,
  caseId: string,
  file: { filename: string; bytes: Buffer },
): Promise<string> {
  assertAllowed(ctx, "safeguarding.manage");
  const { mime } = checkFile("safeguarding_document", file.bytes);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    await readCase(tx, ctx, caseId);
    const [row] = await tx
      .insert(safeguardingDocuments)
      .values({
        tenantId: ctx.tenant.id,
        caseId,
        filename: file.filename.replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "document",
        mime,
        sizeBytes: file.bytes.length,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
        content: file.bytes,
        uploadedByUserId: ctx.userId,
      })
      .returning({ id: safeguardingDocuments.id });
    await addEntryInTx(tx, ctx, caseId, {
      kind: "note",
      body: `Document added: ${file.filename.slice(0, 120)}`,
    });
    return row!.id;
  });
}

/** A case document; every download is recorded on the case (SFG-01d). */
export async function downloadCaseDocument(
  database: Database,
  ctx: TenantContext,
  caseId: string,
  documentId: string,
): Promise<{ filename: string; mime: string; content: Buffer } | null> {
  assertAllowed(ctx, "safeguarding.manage");
  if (!UUID.safeParse(caseId).success || !UUID.safeParse(documentId).success) return null;
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [doc] = await tx
      .select()
      .from(safeguardingDocuments)
      .where(
        and(
          eq(safeguardingDocuments.tenantId, ctx.tenant.id),
          eq(safeguardingDocuments.id, documentId),
          eq(safeguardingDocuments.caseId, caseId),
          isNull(safeguardingDocuments.removedAt),
        ),
      );
    if (!doc) return null;
    await tx
      .insert(safeguardingAccess)
      .values({ tenantId: ctx.tenant.id, caseId, userId: ctx.userId, action: "downloaded" });
    return { filename: doc.filename, mime: doc.mime, content: doc.content };
  });
}

export async function removeCaseDocument(
  database: Database,
  ctx: TenantContext,
  caseId: string,
  documentId: string,
): Promise<void> {
  assertAllowed(ctx, "safeguarding.manage");
  if (!UUID.safeParse(documentId).success) throw new DomainError("not_found", "Document not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    await readCase(tx, ctx, caseId);
    const [removed] = await tx
      .update(safeguardingDocuments)
      .set({ removedAt: new Date(), removedByUserId: ctx.userId })
      .where(
        and(
          eq(safeguardingDocuments.tenantId, ctx.tenant.id),
          eq(safeguardingDocuments.id, documentId),
          eq(safeguardingDocuments.caseId, caseId),
          isNull(safeguardingDocuments.removedAt),
        ),
      )
      .returning({ filename: safeguardingDocuments.filename });
    if (!removed) throw new DomainError("not_found", "Document not found.");
    await addEntryInTx(tx, ctx, caseId, { kind: "note", body: `Document removed: ${removed.filename}` });
  });
}
