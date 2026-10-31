import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertCan } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { academicYears, terms } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import type { TenantContext } from "../tenancy/service";

/**
 * Academic calendar. Ghanaian basic schools usually run three terms per year, but term dates vary by
 * school and year, so they are entered by each school (assumption to verify: no fixed GES calendar is imposed).
 */

export interface Term {
  id: string;
  name: string;
  sequence: number;
  startsOn: string;
  endsOn: string;
  isCurrent: boolean;
}

export interface AcademicYear {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  terms: Term[];
}

const PG_EXCLUSION_VIOLATION = "23P01";
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date.")
  .refine((d) => !Number.isNaN(Date.parse(d)), "Enter a valid date.");

const termInput = z
  .object({
    name: z.string().trim().min(1, "Enter a name.").max(40, "Use 40 characters or fewer."),
    startsOn: isoDate,
    endsOn: isoDate,
  })
  .refine((t) => t.endsOn > t.startsOn, { message: "The term must end after it starts.", path: ["endsOn"] });

export const academicYearSchema = z
  .object({
    name: z
      .string()
      .trim()
      .regex(/^\d{4}\/\d{4}$/, "Use the form 2026/2027.")
      .refine(
        (n) => Number(n.slice(5)) === Number(n.slice(0, 4)) + 1,
        "The second year must follow the first.",
      ),
    terms: z.array(termInput).min(1, "Add at least one term.").max(6, "Use 6 terms or fewer."),
  })
  .superRefine((year, ctx) => {
    for (let i = 1; i < year.terms.length; i++) {
      if (year.terms[i]!.startsOn <= year.terms[i - 1]!.endsOn) {
        ctx.addIssue({
          code: "custom",
          message: "Each term must start after the previous one ends.",
          path: ["terms", i, "startsOn"],
        });
      }
    }
  });

const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenant.id, userId: ctx.userId });

function mapConstraint(error: unknown): never {
  const code = pgErrorCode(error);
  if (code === PG_EXCLUSION_VIOLATION) {
    throw new DomainError("calendar_overlap", "These dates overlap another term or academic year.");
  }
  if (code === PG_UNIQUE_VIOLATION) {
    throw new DomainError("calendar_duplicate", "An academic year with this name already exists.", "name");
  }
  throw error;
}

export async function listAcademicYears(database: Database, ctx: TenantContext): Promise<AcademicYear[]> {
  return withTenant(database, scope(ctx), async (tx) => {
    const years = await tx
      .select()
      .from(academicYears)
      .where(eq(academicYears.tenantId, ctx.tenant.id))
      .orderBy(asc(academicYears.startsOn));
    const allTerms = await tx
      .select()
      .from(terms)
      .where(eq(terms.tenantId, ctx.tenant.id))
      .orderBy(asc(terms.sequence));
    return years
      .map((y) => ({
        id: y.id,
        name: y.name,
        startsOn: y.startsOn,
        endsOn: y.endsOn,
        terms: allTerms
          .filter((t) => t.academicYearId === y.id)
          .map((t) => ({
            id: t.id,
            name: t.name,
            sequence: t.sequence,
            startsOn: t.startsOn,
            endsOn: t.endsOn,
            isCurrent: t.isCurrent,
          })),
      }))
      .reverse();
  });
}

export async function getCurrentTerm(
  database: Database,
  ctx: TenantContext,
): Promise<(Term & { yearName: string }) | null> {
  return withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .select({ term: terms, yearName: academicYears.name })
      .from(terms)
      .innerJoin(academicYears, eq(academicYears.id, terms.academicYearId))
      .where(and(eq(terms.tenantId, ctx.tenant.id), eq(terms.isCurrent, true)));
    if (!row) return null;
    const t = row.term;
    return {
      id: t.id,
      name: t.name,
      sequence: t.sequence,
      startsOn: t.startsOn,
      endsOn: t.endsOn,
      isCurrent: true,
      yearName: row.yearName,
    };
  });
}

/** Creates a year with its terms. The year spans its first term's start to its last term's end. */
export async function createAcademicYear(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<string> {
  assertCan(ctx.roles, "academics.manage");
  const data = academicYearSchema.parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    const [year] = await tx
      .insert(academicYears)
      .values({
        tenantId: ctx.tenant.id,
        name: data.name,
        startsOn: data.terms[0]!.startsOn,
        endsOn: data.terms[data.terms.length - 1]!.endsOn,
      })
      .returning({ id: academicYears.id });
    await tx.insert(terms).values(
      data.terms.map((t, i) => ({
        tenantId: ctx.tenant.id,
        academicYearId: year!.id,
        name: t.name,
        sequence: i + 1,
        startsOn: t.startsOn,
        endsOn: t.endsOn,
      })),
    );
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "academic_year.created",
      entityType: "academic_year",
      entityId: year!.id,
      metadata: { name: data.name, terms: data.terms.length },
    });
    return year!.id;
  }).catch(mapConstraint);
}

async function loadTerm(tx: Transaction, ctx: TenantContext, termId: string) {
  if (!z.string().uuid().safeParse(termId).success)
    throw new DomainError("term_not_found", "Term not found.");
  const [term] = await tx
    .select()
    .from(terms)
    .where(and(eq(terms.tenantId, ctx.tenant.id), eq(terms.id, termId)))
    .for("update");
  if (!term) throw new DomainError("term_not_found", "Term not found.");
  return term;
}

/** Changes a term's name or dates and keeps the year's span in line with its terms. */
export async function updateTerm(
  database: Database,
  ctx: TenantContext,
  termId: string,
  input: unknown,
): Promise<void> {
  assertCan(ctx.roles, "academics.manage");
  const data = termInput.parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTerm(tx, ctx, termId);
    await tx
      .update(terms)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(terms.id, term.id));
    const siblings = await tx
      .select()
      .from(terms)
      .where(eq(terms.academicYearId, term.academicYearId))
      .orderBy(asc(terms.sequence));
    for (let i = 1; i < siblings.length; i++) {
      if (siblings[i]!.startsOn <= siblings[i - 1]!.endsOn) {
        throw new DomainError(
          "term_order",
          "Terms must stay in order: each must start after the previous one ends.",
        );
      }
    }
    await tx
      .update(academicYears)
      .set({
        startsOn: siblings[0]!.startsOn,
        endsOn: siblings[siblings.length - 1]!.endsOn,
        updatedAt: new Date(),
      })
      .where(eq(academicYears.id, term.academicYearId));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "term.updated",
      entityType: "term",
      entityId: term.id,
      metadata: {
        changes: {
          name: { from: term.name, to: data.name },
          dates: { from: `${term.startsOn} – ${term.endsOn}`, to: `${data.startsOn} – ${data.endsOn}` },
        },
      },
    });
  }).catch(mapConstraint);
}

/** Marks the term the school is in now. Fees and attendance default to the current term. */
export async function setCurrentTerm(database: Database, ctx: TenantContext, termId: string): Promise<void> {
  assertCan(ctx.roles, "academics.manage");
  await withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTerm(tx, ctx, termId);
    if (term.isCurrent) return;
    await tx
      .update(terms)
      .set({ isCurrent: false, updatedAt: new Date() })
      .where(and(eq(terms.tenantId, ctx.tenant.id), eq(terms.isCurrent, true)));
    await tx.update(terms).set({ isCurrent: true, updatedAt: new Date() }).where(eq(terms.id, term.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "term.made_current",
      entityType: "term",
      entityId: term.id,
      metadata: { name: term.name },
    });
  });
}

/** Suggested names and empty dates for a new year's three terms. */
export function suggestedYear(today = new Date()): { name: string; terms: { name: string }[] } {
  // Ghanaian school years usually start around September.
  const start = today.getUTCMonth() >= 7 ? today.getUTCFullYear() : today.getUTCFullYear() - 1;
  return {
    name: `${start}/${start + 1}`,
    terms: [{ name: "Term 1" }, { name: "Term 2" }, { name: "Term 3" }],
  };
}
