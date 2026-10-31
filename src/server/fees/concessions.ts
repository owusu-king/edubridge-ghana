import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { parseCedis } from "@/lib/money";
import { recordAudit } from "../audit/record";
import { assertCan } from "../authz/permissions";
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
import type { TenantContext } from "../tenancy/service";
import { loadFinanceStudent } from "./access";

/**
 * Scholarships and discounts per student. Sibling discounts are added the same way: schools differ on
 * which child and which items qualify (assumption to confirm with pilot schools), so the school decides
 * per child, helped by the list of families with more than one child enrolled.
 */

export interface Concession {
  id: string;
  label: string;
  feeItemName: string | null;
  percentBasisPoints: number | null;
  amountPesewas: number | null;
  status: "active" | "ended";
  createdBy: string | null;
  createdAt: Date;
}

const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenant.id, userId: ctx.userId });

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
  assertCan(ctx.roles, "fees.view");
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

const addSchema = z
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
    const pesewas = parseCedis(v.value);
    if (pesewas === null || pesewas === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "Enter an amount in cedis, like 100 or 100.50.",
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
  assertCan(ctx.roles, "fees.manage");
  const data = addSchema.parse(input);
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
    const [row] = await tx
      .insert(feeConcessions)
      .values({ tenantId: ctx.tenant.id, studentId: student.id, ...data, createdByUserId: ctx.userId })
      .returning({ id: feeConcessions.id });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "fees.concession_added",
      entityType: "student",
      entityId: student.id,
      metadata: {
        label: data.label,
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
  assertCan(ctx.roles, "fees.manage");
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

/** Guardians with two or more active children, for deciding sibling discounts. */
export async function listFamilies(database: Database, ctx: TenantContext): Promise<Family[]> {
  assertCan(ctx.roles, "fees.view");
  return withTenant(database, scope(ctx), async (tx) => {
    const rows = await tx
      .select({
        guardianId: guardians.id,
        guardianName: guardians.fullName,
        phone: guardians.phone,
        studentId: students.id,
        firstName: students.firstName,
        lastName: students.lastName,
        admissionNumber: students.admissionNumber,
        className: classes.name,
        campusId: classes.campusId,
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
      .where(eq(studentGuardians.tenantId, ctx.tenant.id))
      .orderBy(asc(guardians.fullName), asc(students.lastName), asc(students.firstName));
    const visible = rows.filter(
      (r) => ctx.campusIds === null || (r.campusId !== null && ctx.campusIds.includes(r.campusId)),
    );
    const byGuardian = new Map<string, typeof visible>();
    for (const r of visible) byGuardian.set(r.guardianId, [...(byGuardian.get(r.guardianId) ?? []), r]);
    const families = [...byGuardian.values()].filter((kids) => kids.length >= 2);
    const studentIds = [...new Set(families.flat().map((r) => r.studentId))];
    const active = studentIds.length
      ? await tx
          .select({ studentId: feeConcessions.studentId, label: feeConcessions.label })
          .from(feeConcessions)
          .where(
            and(
              eq(feeConcessions.tenantId, ctx.tenant.id),
              eq(feeConcessions.status, "active"),
              inArray(feeConcessions.studentId, studentIds),
            ),
          )
      : [];
    return families.map((kids) => ({
      guardianId: kids[0]!.guardianId,
      guardianName: kids[0]!.guardianName,
      phone: kids[0]!.phone,
      children: kids.map((k) => ({
        id: k.studentId,
        name: `${k.firstName} ${k.lastName}`,
        admissionNumber: k.admissionNumber,
        className: k.className,
        concessions: active.filter((a) => a.studentId === k.studentId).map((a) => a.label),
      })),
    }));
  });
}
