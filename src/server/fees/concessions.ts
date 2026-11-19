import "server-only";
import { and, asc, count, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { parseMoney } from "@/lib/money";
import { normalizePhone } from "@/lib/phone";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import {
  classes,
  enrolments,
  feeConcessions,
  feeItems,
  guardians,
  studentGuardians,
  students,
  terms,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import { readPreferences } from "../tenancy/preferences";
import type { TenantContext } from "../tenancy/service";
import { loadFinanceStudent } from "./access";

/**
 * Scholarships and discounts per student. Sibling discounts can be added by hand the same way, or by the
 * school's sibling discount rule (fees/siblings.ts), which manages only the discounts it created.
 */

export interface Concession {
  id: string;
  label: string;
  feeItemName: string | null;
  percentBasisPoints: number | null;
  amountPesewas: number | null;
  status: "pending" | "active" | "ended";
  createdBy: string | null;
  createdAt: Date;
}

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

/** "10%", "12.5%". */
export function formatPercent(basisPoints: number): string {
  const whole = Math.trunc(basisPoints / 100);
  const rest = basisPoints % 100;
  return `${whole}${rest ? `.${String(rest).padStart(2, "0").replace(/0$/, "")}` : ""}%`;
}

/** Reads "10", "12.5" or "12.5%" as basis points (1–10000), or null. */
export function parsePercent(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?\s*%?$/.exec(text.trim());
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bp >= 1 && bp <= 10000 ? bp : null;
}

export async function listConcessions(
  database: Database,
  ctx: TenantContext,
  studentId: string,
): Promise<Concession[]> {
  assertAllowed(ctx, "fees.view");
  if (!z.string().uuid().safeParse(studentId).success) return [];
  return withTenant(database, scope(ctx), async (tx) => {
    if (!(await loadFinanceStudent(tx, ctx, studentId))) return [];
    return tx
      .select({
        id: feeConcessions.id,
        label: feeConcessions.label,
        feeItemName: feeItems.name,
        percentBasisPoints: feeConcessions.percentBasisPoints,
        amountPesewas: feeConcessions.amountPesewas,
        status: feeConcessions.status,
        createdBy: users.name,
        createdAt: feeConcessions.createdAt,
      })
      .from(feeConcessions)
      .leftJoin(feeItems, eq(feeItems.id, feeConcessions.feeItemId))
      .leftJoin(users, eq(users.id, feeConcessions.createdByUserId))
      .where(and(eq(feeConcessions.tenantId, ctx.tenant.id), eq(feeConcessions.studentId, studentId)))
      .orderBy(asc(feeConcessions.status), asc(feeConcessions.createdAt));
  });
}

const addSchema = (currency: string) =>
  z
    .object({
      label: z
        .string()
        .trim()
        .min(2, "Name the discount, e.g. Academic scholarship.")
        .max(60, "Use 60 characters or fewer."),
      feeItemId: z.preprocess((v) => (v === "" ? null : v), z.string().uuid().nullable()),
      kind: z.enum(["percent", "amount"], { message: "Choose a percentage or an amount." }),
      value: z.string(),
    })
    .transform((v, ctx) => {
      if (v.kind === "percent") {
        const bp = parsePercent(v.value);
        if (bp === null) {
          ctx.addIssue({ code: "custom", path: ["value"], message: "Enter a percentage from 0.01 to 100." });
          return z.NEVER;
        }
        return { label: v.label, feeItemId: v.feeItemId, percentBasisPoints: bp, amountPesewas: null };
      }
      const pesewas = parseMoney(v.value, currency);
      if (pesewas === null || pesewas === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: "Enter an amount, like 100 or 100.50.",
        });
        return z.NEVER;
      }
      if (!v.feeItemId) {
        ctx.addIssue({
          code: "custom",
          path: ["feeItemId"],
          message: "A fixed amount must come off one fee item.",
        });
        return z.NEVER;
      }
      return { label: v.label, feeItemId: v.feeItemId, percentBasisPoints: null, amountPesewas: pesewas };
    });

/** Adds a concession. It takes effect the next time the term is billed (Fees → Fee structure → Bill). */
export async function addConcession(
  database: Database,
  ctx: TenantContext,
  studentId: string,
  input: unknown,
): Promise<string> {
  assertAllowed(ctx, "fees.manage");
  const data = addSchema(ctx.tenant.currencyCode).parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    const student = await loadFinanceStudent(tx, ctx, studentId);
    if (!student) throw new DomainError("student_not_found", "Student not found.");
    if (data.feeItemId) {
      const [item] = await tx
        .select({ id: feeItems.id })
        .from(feeItems)
        .where(
          and(
            eq(feeItems.tenantId, ctx.tenant.id),
            eq(feeItems.id, data.feeItemId),
            eq(feeItems.status, "active"),
          ),
        );
      if (!item) throw new DomainError("unknown_item", "Choose a fee item.", "feeItemId");
    }
    // Above the school's threshold, a discount waits for the Proprietor (who approves their own at once).
    const prefs = await readPreferences(tx, ctx.tenant.id);
    const overPercent =
      data.percentBasisPoints !== null &&
      prefs.discountApprovalBasisPoints !== null &&
      data.percentBasisPoints > prefs.discountApprovalBasisPoints;
    const overAmount =
      data.amountPesewas !== null &&
      prefs.discountApprovalPesewas !== null &&
      data.amountPesewas > prefs.discountApprovalPesewas;
    const pending = (overPercent || overAmount) && !allowed(ctx, "fees.approve_discounts");
    const [row] = await tx
      .insert(feeConcessions)
      .values({
        tenantId: ctx.tenant.id,
        studentId: student.id,
        ...data,
        status: pending ? "pending" : "active",
        createdByUserId: ctx.userId,
        ...(pending ? {} : { approvedByUserId: ctx.userId, approvedAt: new Date() }),
      })
      .returning({ id: feeConcessions.id });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "fees.concession_added",
      entityType: "student",
      entityId: student.id,
      metadata: {
        label: data.label,
        ...(pending ? { awaitingApproval: true } : {}),
        ...(data.percentBasisPoints !== null ? { percent: formatPercent(data.percentBasisPoints) } : {}),
        ...(data.amountPesewas !== null ? { amountPesewas: data.amountPesewas } : {}),
      },
    });
    return row!.id;
  });
}

/** Ends a concession for future billing. Discounts already billed stay; reverse them to take them back. */
export async function endConcession(
  database: Database,
  ctx: TenantContext,
  concessionId: string,
): Promise<void> {
  assertAllowed(ctx, "fees.manage");
  if (!z.string().uuid().safeParse(concessionId).success) throw new DomainError("not_found", "Not found.");
  await withTenant(database, scope(ctx), async (tx) => {
    const [concession] = await tx
      .select()
      .from(feeConcessions)
      .where(and(eq(feeConcessions.tenantId, ctx.tenant.id), eq(feeConcessions.id, concessionId)));
    if (!concession || !(await loadFinanceStudent(tx, ctx, concession.studentId)))
      throw new DomainError("not_found", "Not found.");
    if (concession.status === "ended") return;
    await tx
      .update(feeConcessions)
      .set({ status: "ended", endedAt: new Date(), endedByUserId: ctx.userId, updatedAt: new Date() })
      .where(eq(feeConcessions.id, concessionId));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "fees.concession_ended",
      entityType: "student",
      entityId: concession.studentId,
      metadata: { label: concession.label },
    });
  });
}

/** The Proprietor approves a discount above the school's threshold; it is billed from the next billing. */
export async function approveConcession(
  database: Database,
  ctx: TenantContext,
  concessionId: string,
): Promise<void> {
  assertAllowed(ctx, "fees.approve_discounts");
  if (!z.string().uuid().safeParse(concessionId).success) throw new DomainError("not_found", "Not found.");
  await withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .update(feeConcessions)
      .set({ status: "active", approvedByUserId: ctx.userId, approvedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(feeConcessions.tenantId, ctx.tenant.id),
          eq(feeConcessions.id, concessionId),
          eq(feeConcessions.status, "pending"),
        ),
      )
      .returning({ studentId: feeConcessions.studentId, label: feeConcessions.label });
    if (!row) throw new DomainError("not_found", "This discount is not waiting for approval.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "fees.concession_approved",
      entityType: "student",
      entityId: row.studentId,
      metadata: { label: row.label },
    });
  });
}

/** Discounts waiting for the Proprietor's approval, across the school. */
export async function listPendingConcessions(
  database: Database,
  ctx: TenantContext,
): Promise<
  {
    id: string;
    studentId: string;
    studentName: string;
    label: string;
    percentBasisPoints: number | null;
    amountPesewas: number | null;
    requestedBy: string | null;
    createdAt: Date;
  }[]
> {
  assertAllowed(ctx, "fees.view");
  return withTenant(database, scope(ctx), async (tx) => {
    const rows = await tx
      .select({
        id: feeConcessions.id,
        studentId: feeConcessions.studentId,
        first: students.firstName,
        last: students.lastName,
        label: feeConcessions.label,
        percentBasisPoints: feeConcessions.percentBasisPoints,
        amountPesewas: feeConcessions.amountPesewas,
        requestedBy: users.name,
        createdAt: feeConcessions.createdAt,
      })
      .from(feeConcessions)
      .innerJoin(students, eq(students.id, feeConcessions.studentId))
      .leftJoin(users, eq(users.id, feeConcessions.createdByUserId))
      .where(and(eq(feeConcessions.tenantId, ctx.tenant.id), eq(feeConcessions.status, "pending")))
      .orderBy(asc(feeConcessions.createdAt));
    return rows.map(({ first, last, ...r }) => ({ ...r, studentName: `${first} ${last}` }));
  });
}

export interface Family {
  guardianId: string;
  guardianName: string;
  phone: string | null;
  children: {
    id: string;
    name: string;
    admissionNumber: string;
    className: string | null;
    concessions: string[];
  }[];
}

export const FAMILIES_PAGE_SIZE = 25;

export interface FamiliesPage {
  families: Family[];
  /** Families matching the search, on every page. */
  total: number;
  page: number;
}

/**
 * Guardians with two or more active children, for deciding sibling discounts, a page at a time (a large
 * school has hundreds). The search matches the guardian's name or phone, or a child's name or admission
 * number. Campus scope applies to the children: a family counts only if two of its children are visible.
 */
export async function listFamilies(
  database: Database,
  ctx: TenantContext,
  input: { q?: string; page?: number } = {},
): Promise<FamiliesPage> {
  assertAllowed(ctx, "fees.view");
  return withTenant(database, scope(ctx), async (tx) => {
    const visible = tx
      .select({
        guardianId: studentGuardians.guardianId,
        guardianName: guardians.fullName,
        phone: guardians.phone,
        studentId: students.id,
        firstName: students.firstName,
        lastName: students.lastName,
        admissionNumber: students.admissionNumber,
        className: classes.name,
      })
      .from(studentGuardians)
      .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
      .innerJoin(students, and(eq(students.id, studentGuardians.studentId), eq(students.status, "active")))
      .leftJoin(
        enrolments,
        and(
          eq(enrolments.studentId, students.id),
          sql`${enrolments.termId} = (select id from ${terms} where ${terms.tenantId} = ${ctx.tenant.id} and ${terms.isCurrent})`,
        ),
      )
      .leftJoin(classes, eq(classes.id, enrolments.classId))
      .where(
        and(
          eq(studentGuardians.tenantId, ctx.tenant.id),
          ctx.campusIds === null
            ? undefined
            : ctx.campusIds.length
              ? inArray(classes.campusId, ctx.campusIds)
              : sql`false`,
        ),
      )
      .as("visible");

    const conditions: SQL[] = [sql`count(distinct ${visible.studentId}) >= 2`];
    const q = input.q?.trim().slice(0, 60);
    if (q) {
      const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const matches: SQL[] = [
        sql`${visible.guardianName} ilike ${pattern}`,
        sql`bool_or((${visible.firstName} || ' ' || ${visible.lastName}) ilike ${pattern} or ${visible.admissionNumber} ilike ${pattern})`,
      ];
      const digits = q.replace(/\D/g, "");
      if (digits.length >= 6 && !/[A-Za-z]/.test(q)) {
        const full = normalizePhone(q, ctx.tenant.countryCode);
        matches.push(
          full
            ? sql`(${visible.phone} = ${full} or ${visible.phone} like ${`%${digits.replace(/^0/, "")}%`})`
            : sql`${visible.phone} like ${`%${digits.replace(/^0/, "")}%`}`,
        );
      }
      conditions.push(sql`(${sql.join(matches, sql` or `)})`);
    }
    const families = tx
      .select({ guardianId: visible.guardianId, guardianName: visible.guardianName })
      .from(visible)
      .groupBy(visible.guardianId, visible.guardianName, visible.phone)
      .having(and(...conditions))
      .as("families");

    const [{ total } = { total: 0 }] = await tx.select({ total: count() }).from(families);
    const page = Math.min(
      Math.max(1, Math.floor(input.page ?? 1)),
      Math.max(1, Math.ceil(total / FAMILIES_PAGE_SIZE)),
    );
    const ids = (
      await tx
        .select({ guardianId: families.guardianId })
        .from(families)
        .orderBy(asc(families.guardianName), asc(families.guardianId))
        .limit(FAMILIES_PAGE_SIZE)
        .offset((page - 1) * FAMILIES_PAGE_SIZE)
    ).map((r) => r.guardianId);
    if (!ids.length) return { families: [], total, page };

    const rows = await tx
      .select()
      .from(visible)
      .where(inArray(visible.guardianId, ids))
      .orderBy(asc(visible.lastName), asc(visible.firstName), asc(visible.studentId));
    const active = await tx
      .select({ studentId: feeConcessions.studentId, label: feeConcessions.label })
      .from(feeConcessions)
      .where(
        and(
          eq(feeConcessions.tenantId, ctx.tenant.id),
          eq(feeConcessions.status, "active"),
          inArray(feeConcessions.studentId, [...new Set(rows.map((r) => r.studentId))]),
        ),
      );
    const labels = new Map<string, string[]>();
    for (const a of active) labels.set(a.studentId, [...(labels.get(a.studentId) ?? []), a.label]);
    return {
      total,
      page,
      families: ids.map((guardianId) => {
        const kids = rows.filter((r) => r.guardianId === guardianId);
        return {
          guardianId,
          guardianName: kids[0]!.guardianName,
          phone: kids[0]!.phone,
          children: kids.map((k) => ({
            id: k.studentId,
            name: `${k.firstName} ${k.lastName}`,
            admissionNumber: k.admissionNumber,
            className: k.className,
            concessions: labels.get(k.studentId) ?? [],
          })),
        };
      }),
    };
  });
}
