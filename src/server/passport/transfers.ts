import "server-only";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { ledgerEntries, students, tenants, transfers } from "../db/schema";
import { DomainError } from "../errors";
import { linkedStudents } from "../parents/portal";
import { schoolsForPhone } from "../parents/schools";
import { createStudent } from "../students/service";
import type { TenantContext } from "../tenancy/service";
import { normalizePhone } from "../../lib/phone";
import { addGuardiansFrom, issueRecordInTx, storePriorRecordInTx, verifyLearnerPackage } from "./records";

/**
 * Transfers between independent schools (Transfer Passport):
 *
 *  1. Started by the family in the parent view (consent given there), or requested by the receiving school,
 *     which names the child and a guardian's phone. The receiving school is never told whether the child
 *     was found: a request reaches the family only if the school being left has that guardian's number
 *     for a child of that name.
 *  2. The family consents (or refuses) in the parent view, signed in with the guardian's number.
 *  3. The school being left sees the request only now. It approves (a signed learner record is issued and
 *     the student is withdrawn as transferred) or declines with a reason. Fees owed are shown, never used
 *     to block automatically (founder decision pending).
 *  4. The receiving school checks the signature and accepts: its student is created with the same learner
 *     identity, guardians and the received record. Every step is audited at the school that took it.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});
const system = (tenantId: string) => ({ tenantId, userId: "" });

/** Open requests expire after this long. */
const EXPIRES_DAYS = 30;
const OPEN = ["awaiting_consent", "awaiting_origin", "approved"] as const;

const norm = (v: string) => v.trim().replace(/\s+/g, " ").toLowerCase();

export interface SchoolOption {
  id: string;
  name: string;
}

/** Schools a child can move from or to (active, not demonstration, not this one). */
export async function listTransferSchools(
  database: Database,
  exceptTenantId: string | null,
): Promise<SchoolOption[]> {
  return database
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(
      and(
        eq(tenants.status, "active"),
        eq(tenants.isDemo, false),
        exceptTenantId ? ne(tenants.id, exceptTenantId) : undefined,
      ),
    )
    .orderBy(tenants.name);
}

async function activeSchool(database: Database, id: string): Promise<{ id: string; name: string } | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  const [row] = await database
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(and(eq(tenants.id, id), eq(tenants.status, "active"), eq(tenants.isDemo, false)));
  return row ?? null;
}

const requestSchema = z.object({
  fromSchoolId: z.string().uuid("Choose the school the child is leaving."),
  firstName: z.string().trim().min(1, "Enter the child's first name.").max(60),
  lastName: z.string().trim().min(1, "Enter the child's surname.").max(60),
  dateOfBirth: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date.")
      .optional(),
  ),
  guardianPhone: z.string().transform((v, issue) => {
    const phone = normalizePhone(v);
    if (!phone) {
      issue.addIssue({ code: "custom", message: "Enter the guardian's mobile number, e.g. 024 123 4567." });
      return z.NEVER;
    }
    return phone;
  }),
});

/** The receiving school asks for a child's records (step 1). */
export async function requestTransfer(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<string> {
  assertAllowed(ctx, "transfers.manage");
  const data = requestSchema.parse(input);
  if (data.fromSchoolId === ctx.tenant.id)
    throw new DomainError("same_school", "Choose another school.", "fromSchoolId");
  const origin = await activeSchool(database, data.fromSchoolId);
  if (!origin)
    throw new DomainError("school_not_found", "Choose the school the child is leaving.", "fromSchoolId");
  // Matched at the school being left by the guardian's number and the child's name; the requester is not told.
  const matches = await withTenant(database, system(origin.id), async (tx) =>
    (await linkedStudents(tx, origin.id, data.guardianPhone)).filter(
      (s) =>
        s.status === "active" &&
        norm(s.firstName) === norm(data.firstName) &&
        norm(s.lastName) === norm(data.lastName),
    ),
  );
  return withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .insert(transfers)
      .values({
        fromTenantId: origin.id,
        toTenantId: ctx.tenant.id,
        requestedBy: "school",
        requestedByUserId: ctx.userId,
        childFirstName: data.firstName,
        childLastName: data.lastName,
        childDateOfBirth: data.dateOfBirth ?? null,
        guardianPhone: data.guardianPhone,
        fromStudentId: matches.length === 1 ? matches[0]!.id : null,
        status: "awaiting_consent",
        expiresAt: sql`now() + make_interval(days => ${EXPIRES_DAYS})`,
      })
      .returning({ id: transfers.id });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "transfer.requested",
      entityType: "transfer",
      entityId: row!.id,
      metadata: { fromSchool: origin.name, child: `${data.firstName} ${data.lastName}` },
    });
    return row!.id;
  });
}

async function assertNoOpenTransfer(tx: Transaction, fromTenantId: string, studentId: string) {
  const [open] = await tx
    .select({ id: transfers.id })
    .from(transfers)
    .where(
      and(
        eq(transfers.fromTenantId, fromTenantId),
        eq(transfers.fromStudentId, studentId),
        inArray(transfers.status, ["awaiting_origin", "approved"]),
        sql`${transfers.expiresAt} > now()`,
      ),
    );
  if (open)
    throw new DomainError("transfer_open", "A move to another school is already in progress for this child.");
}

/** The family starts a move in the parent view: their consent is given by starting it (step 1 and 2). */
export async function startTransferAsGuardian(
  database: Database,
  phone: string,
  input: { slug: string; studentId: string; toSchoolId: unknown },
): Promise<string> {
  const school = (await schoolsForPhone(database, phone)).find((s) => s.slug === input.slug);
  if (!school || !z.string().uuid().safeParse(input.studentId).success)
    throw new DomainError("student_not_found", "Child not found.");
  const toSchoolId = z.string().uuid("Choose the new school.").parse(input.toSchoolId);
  if (toSchoolId === school.id) throw new DomainError("same_school", "Choose another school.", "toSchoolId");
  const destination = await activeSchool(database, toSchoolId);
  if (!destination) throw new DomainError("school_not_found", "Choose the new school.", "toSchoolId");
  return withTenant(database, system(school.id), async (tx) => {
    const [child] = await linkedStudents(tx, school.id, phone, input.studentId);
    if (!child || child.status !== "active") throw new DomainError("student_not_found", "Child not found.");
    await assertNoOpenTransfer(tx, school.id, child.id);
    const [row] = await tx
      .insert(transfers)
      .values({
        fromTenantId: school.id,
        toTenantId: destination.id,
        requestedBy: "guardian",
        childFirstName: child.firstName,
        childLastName: child.lastName,
        guardianPhone: phone,
        fromStudentId: child.id,
        status: "awaiting_origin",
        consentPhone: phone,
        consentedAt: new Date(),
        expiresAt: sql`now() + make_interval(days => ${EXPIRES_DAYS})`,
      })
      .returning({ id: transfers.id });
    await recordAudit(tx, {
      tenantId: school.id,
      actorUserId: null,
      action: "transfer.started_by_family",
      entityType: "transfer",
      entityId: row!.id,
      metadata: { toSchool: destination.name, studentId: child.id, consentPhone: phone },
    });
    return row!.id;
  });
}

export interface ConsentRequest {
  id: string;
  slug: string;
  schoolName: string;
  toSchoolName: string;
  childName: string;
  createdAt: Date;
}

/** Requests from receiving schools waiting for this number's consent, across the family's schools. */
export async function listConsentRequests(database: Database, phone: string): Promise<ConsentRequest[]> {
  const result: ConsentRequest[] = [];
  for (const school of await schoolsForPhone(database, phone)) {
    const rows = await withTenant(database, system(school.id), async (tx) => {
      const children = await linkedStudents(tx, school.id, phone);
      if (!children.length) return [];
      return tx
        .select({
          id: transfers.id,
          toSchoolName: tenants.name,
          first: transfers.childFirstName,
          last: transfers.childLastName,
          createdAt: transfers.createdAt,
        })
        .from(transfers)
        .innerJoin(tenants, eq(tenants.id, transfers.toTenantId))
        .where(
          and(
            eq(transfers.fromTenantId, school.id),
            eq(transfers.status, "awaiting_consent"),
            eq(transfers.guardianPhone, phone),
            inArray(
              transfers.fromStudentId,
              children.map((c) => c.id),
            ),
            sql`${transfers.expiresAt} > now()`,
          ),
        )
        .orderBy(desc(transfers.createdAt));
    });
    result.push(
      ...rows.map((r) => ({
        id: r.id,
        slug: school.slug,
        schoolName: school.name,
        toSchoolName: r.toSchoolName,
        childName: `${r.first} ${r.last}`,
        createdAt: r.createdAt,
      })),
    );
  }
  return result;
}

/** The family's answer to a receiving school's request (step 2). */
export async function answerConsent(
  database: Database,
  phone: string,
  input: { slug: string; transferId: string; allow: boolean },
): Promise<void> {
  const school = (await schoolsForPhone(database, phone)).find((s) => s.slug === input.slug);
  if (!school || !z.string().uuid().safeParse(input.transferId).success)
    throw new DomainError("transfer_not_found", "Request not found.");
  await withTenant(database, system(school.id), async (tx) => {
    const children = (await linkedStudents(tx, school.id, phone)).map((c) => c.id);
    const [t] = await tx
      .select()
      .from(transfers)
      .where(
        and(
          eq(transfers.id, input.transferId),
          eq(transfers.fromTenantId, school.id),
          eq(transfers.status, "awaiting_consent"),
          eq(transfers.guardianPhone, phone),
          sql`${transfers.expiresAt} > now()`,
        ),
      )
      .for("update");
    if (!t || !t.fromStudentId || !children.includes(t.fromStudentId))
      throw new DomainError("transfer_not_found", "Request not found.");
    if (input.allow) await assertNoOpenTransfer(tx, school.id, t.fromStudentId);
    await tx
      .update(transfers)
      .set(
        input.allow
          ? { status: "awaiting_origin", consentPhone: phone, consentedAt: new Date() }
          : { status: "declined", declineReason: "The family did not consent.", decidedAt: new Date() },
      )
      .where(eq(transfers.id, t.id));
    await recordAudit(tx, {
      tenantId: school.id,
      actorUserId: null,
      action: input.allow ? "transfer.consented" : "transfer.consent_refused",
      entityType: "transfer",
      entityId: t.id,
      metadata: { studentId: t.fromStudentId, phone },
    });
  });
}

export interface TransferRow {
  id: string;
  direction: "incoming" | "outgoing";
  otherSchool: string;
  childName: string;
  status: (typeof transfers.$inferSelect)["status"] | "expired";
  requestedBy: "guardian" | "school";
  createdAt: Date;
  decidedAt: Date | null;
  declineReason: string | null;
  fromStudentId: string | null;
  toStudentId: string | null;
  /** Outgoing, awaiting approval: what the family owes the school being left (shown, never used to block). */
  balancePesewas: number | null;
}

/**
 * This school's transfers. Incoming: everything it requested or that was started towards it, but a request
 * the family has not consented to only says it is waiting (never whether the child was found). Outgoing:
 * only once the family has consented.
 */
export async function listTransfers(database: Database, ctx: TenantContext): Promise<TransferRow[]> {
  assertAllowed(ctx, "transfers.manage");
  return withTenant(database, scope(ctx), async (tx) => {
    const other = sql<string>`(select name from ${tenants} o where o.id = case when ${transfers.toTenantId} = ${ctx.tenant.id} then ${transfers.fromTenantId} else ${transfers.toTenantId} end)`;
    const rows = await tx
      .select({ t: transfers, otherSchool: other, expired: sql<boolean>`${transfers.expiresAt} <= now()` })
      .from(transfers)
      .where(
        or(
          eq(transfers.toTenantId, ctx.tenant.id),
          and(eq(transfers.fromTenantId, ctx.tenant.id), ne(transfers.status, "awaiting_consent")),
        ),
      )
      .orderBy(desc(transfers.createdAt))
      .limit(200);
    const owing = rows
      .filter(
        (r) => r.t.fromTenantId === ctx.tenant.id && r.t.status === "awaiting_origin" && r.t.fromStudentId,
      )
      .map((r) => r.t.fromStudentId!);
    const balances = new Map<string, number>();
    if (owing.length)
      for (const b of await tx
        .select({
          studentId: ledgerEntries.studentId,
          total: sql<string>`sum(${ledgerEntries.amountPesewas})`,
        })
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.tenantId, ctx.tenant.id), inArray(ledgerEntries.studentId, owing)))
        .groupBy(ledgerEntries.studentId))
        balances.set(b.studentId, Number(b.total));
    return rows.map(({ t, otherSchool, expired }) => {
      const incoming = t.toTenantId === ctx.tenant.id;
      const open = (OPEN as readonly string[]).includes(t.status);
      return {
        id: t.id,
        direction: incoming ? "incoming" : "outgoing",
        otherSchool,
        childName: `${t.childFirstName} ${t.childLastName}`,
        status: open && expired ? "expired" : t.status,
        requestedBy: t.requestedBy,
        createdAt: t.createdAt,
        decidedAt: t.decidedAt,
        declineReason: t.declineReason,
        fromStudentId: incoming ? null : t.fromStudentId,
        toStudentId: incoming ? t.toStudentId : null,
        balancePesewas: !incoming && t.fromStudentId ? (balances.get(t.fromStudentId) ?? 0) : null,
      };
    });
  });
}

async function loadOpen(
  tx: Transaction,
  ctx: TenantContext,
  id: string,
  side: "from" | "to",
  status: (typeof transfers.$inferSelect)["status"],
) {
  if (!z.string().uuid().safeParse(id).success)
    throw new DomainError("transfer_not_found", "Transfer not found.");
  const [t] = await tx
    .select()
    .from(transfers)
    .where(
      and(
        eq(transfers.id, id),
        eq(side === "from" ? transfers.fromTenantId : transfers.toTenantId, ctx.tenant.id),
        eq(transfers.status, status),
        sql`${transfers.expiresAt} > now()`,
      ),
    )
    .for("update");
  if (!t)
    throw new DomainError("transfer_not_found", "Transfer not found, or no longer waiting for this step.");
  return t;
}

/** The school being left approves: a signed record is issued and the student withdrawn (step 3). */
export async function approveTransfer(database: Database, ctx: TenantContext, id: string): Promise<void> {
  assertAllowed(ctx, "transfers.manage");
  await withTenant(database, scope(ctx), async (tx) => {
    const t = await loadOpen(tx, ctx, id, "from", "awaiting_origin");
    if (!t.fromStudentId) throw new DomainError("transfer_not_found", "Transfer not found.");
    const [destination] = await tx
      .select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, t.toTenantId));
    const { recordId, pkg } = await issueRecordInTx(tx, ctx, t.fromStudentId, "transfer", {
      toSchool: destination?.name ?? "another school",
    });
    await tx
      .update(transfers)
      .set({
        status: "approved",
        recordId,
        package: pkg as unknown as Record<string, unknown>,
        decidedByUserId: ctx.userId,
        decidedAt: new Date(),
      })
      .where(eq(transfers.id, t.id));
    await tx
      .update(students)
      .set({
        status: "withdrawn",
        leftReason: `Transferred to ${destination?.name ?? "another school"}`,
        updatedAt: new Date(),
      })
      .where(and(eq(students.tenantId, ctx.tenant.id), eq(students.id, t.fromStudentId)));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "transfer.approved",
      entityType: "transfer",
      entityId: t.id,
      metadata: { studentId: t.fromStudentId, toSchool: destination?.name, recordId },
    });
  });
}

/** The school being left declines, with a reason the family and receiving school see (step 3). */
export async function declineTransfer(
  database: Database,
  ctx: TenantContext,
  id: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "transfers.manage");
  const { reason } = z
    .object({ reason: z.string().trim().min(3, "Give a reason.").max(300, "Use 300 characters or fewer.") })
    .parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    const t = await loadOpen(tx, ctx, id, "from", "awaiting_origin");
    await tx
      .update(transfers)
      .set({ status: "declined", declineReason: reason, decidedByUserId: ctx.userId, decidedAt: new Date() })
      .where(eq(transfers.id, t.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "transfer.declined",
      entityType: "transfer",
      entityId: t.id,
      metadata: { studentId: t.fromStudentId, reason },
    });
  });
}

/** The receiving school withdraws its request before it is completed. */
export async function cancelTransfer(database: Database, ctx: TenantContext, id: string): Promise<void> {
  assertAllowed(ctx, "transfers.manage");
  await withTenant(database, scope(ctx), async (tx) => {
    const [t] = await tx
      .select()
      .from(transfers)
      .where(
        and(
          eq(transfers.id, id),
          eq(transfers.toTenantId, ctx.tenant.id),
          inArray(transfers.status, [...OPEN]),
        ),
      )
      .for("update");
    if (!t) throw new DomainError("transfer_not_found", "Transfer not found.");
    await tx
      .update(transfers)
      .set({ status: "cancelled", decidedAt: new Date() })
      .where(eq(transfers.id, t.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "transfer.cancelled",
      entityType: "transfer",
      entityId: t.id,
    });
  });
}

const acceptSchema = z.object({
  classId: z.preprocess((v) => (v === "" ? undefined : v), z.string().uuid().optional()),
});

/** The receiving school verifies the record and enrols the child (step 4). */
export async function acceptTransfer(
  database: Database,
  ctx: TenantContext,
  id: string,
  input: unknown,
): Promise<{ studentId: string; admissionNumber: string }> {
  assertAllowed(ctx, "transfers.manage");
  assertAllowed(ctx, "students.manage");
  const { classId } = acceptSchema.parse(input);
  const pkg = await withTenant(
    database,
    scope(ctx),
    async (tx) => (await loadOpen(tx, ctx, id, "to", "approved")).package,
  );
  const verification = await verifyLearnerPackage(database, pkg);
  if (verification.status !== "valid")
    throw new DomainError(
      "record_invalid",
      verification.status === "revoked"
        ? "The school being left has revoked this record. Ask them to approve again."
        : "The record could not be verified, so the child cannot be enrolled from it.",
    );
  const record = verification.record;
  return withTenant(database, scope(ctx), async (tx) => {
    const t = await loadOpen(tx, ctx, id, "to", "approved");
    const created = await createStudent(
      tx as unknown as Database,
      ctx,
      {
        firstName: record.student.firstName,
        otherNames: record.student.otherNames ?? undefined,
        lastName: record.student.lastName,
        sex: record.student.sex,
        dateOfBirth: record.student.dateOfBirth ?? undefined,
        classId,
      },
      { learnerId: record.learnerId },
    );
    await addGuardiansFrom(tx, ctx, created.id, record.guardians);
    await storePriorRecordInTx(tx, ctx, created.id, "transfer", {
      pkg: pkg as Record<string, unknown>,
      verification,
    });
    await tx
      .update(transfers)
      .set({
        status: "completed",
        acceptedByUserId: ctx.userId,
        acceptedAt: new Date(),
        toStudentId: created.id,
      })
      .where(eq(transfers.id, t.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "transfer.accepted",
      entityType: "transfer",
      entityId: t.id,
      metadata: { studentId: created.id, fromSchool: record.issuer.name, recordId: record.id },
    });
    return { studentId: created.id, admissionNumber: created.admissionNumber };
  });
}
