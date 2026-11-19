import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { addDays } from "../../lib/attendance";
import { AGE_BUCKETS, ageOwed } from "../../lib/dashboard";
import { todayIn } from "../../lib/format";
import { sumPesewas } from "../../lib/money";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { campuses, classes, enrolments, ledgerEntries, levels, students, terms } from "../db/schema";
import type { TenantContext } from "../tenancy/service";
import { campusScopeFilter } from "./access";

/**
 * Finance reports by class, level and campus (FIN-13, FIN-14) and billed by fee category. Every total is
 * computed from the ledger and receipts with the same rules as Fees, Owing and the Overview (so they
 * reconcile): balances and ageing as of today with credits settling the oldest charges first and reversed
 * pairs left out; collections are receipts not voided, dated in the period, grouped by the class the
 * student was in at the time (or this term's class when the date is outside every term). Campus scope applies.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

export const GROUPINGS = ["class", "level", "campus"] as const;
export type Grouping = (typeof GROUPINGS)[number];

interface Placement {
  group: string;
  label: string;
  order: string;
}

/** Each student's group (class, level or campus) this term. */
async function currentPlacements(
  tx: Transaction,
  ctx: TenantContext,
  by: Grouping,
): Promise<Map<string, Placement>> {
  const rows = await tx
    .select({
      studentId: enrolments.studentId,
      classId: classes.id,
      className: classes.name,
      levelId: levels.id,
      levelName: levels.name,
      levelSeq: levels.sequence,
      campusId: campuses.id,
      campusName: campuses.name,
    })
    .from(enrolments)
    .innerJoin(terms, and(eq(terms.id, enrolments.termId), eq(terms.isCurrent, true)))
    .innerJoin(classes, eq(classes.id, enrolments.classId))
    .innerJoin(levels, eq(levels.id, classes.levelId))
    .innerJoin(campuses, eq(campuses.id, classes.campusId))
    .where(eq(enrolments.tenantId, ctx.tenant.id));
  return new Map(
    rows.map((r) => [
      r.studentId,
      by === "class"
        ? {
            group: r.classId,
            label: r.className,
            order: `${String(r.levelSeq).padStart(6, "0")} ${r.className}`,
          }
        : by === "level"
          ? { group: r.levelId, label: r.levelName, order: String(r.levelSeq).padStart(6, "0") }
          : { group: r.campusId, label: r.campusName, order: r.campusName },
    ]),
  );
}

const NONE: Placement = { group: "none", label: "Not in a class this term", order: "~" };

export interface BalanceGroup {
  group: string;
  label: string;
  students: number;
  owing: number;
  owedPesewas: number;
  creditPesewas: number;
  /** Owed by age (AGE_BUCKETS order). */
  buckets: number[];
}

export interface BalanceReport {
  asOf: string;
  groups: BalanceGroup[];
  total: BalanceGroup;
}

/** What families owe today, and for how long, by class, level or campus (FIN-13). */
export async function getBalanceReport(
  database: Database,
  ctx: TenantContext,
  by: Grouping,
): Promise<BalanceReport> {
  assertAllowed(ctx, "fees.view");
  const today = todayIn(ctx.tenant.timezone);
  return withTenant(database, scope(ctx), async (tx) => {
    const placements = await currentPlacements(tx, ctx, by);
    const rows = await tx
      .select({
        studentId: ledgerEntries.studentId,
        amountPesewas: ledgerEntries.amountPesewas,
        effectiveOn: ledgerEntries.effectiveOn,
        paired: sql<boolean>`(${ledgerEntries.reversesEntryId} is not null or exists (select 1 from ledger_entries r where r.reverses_entry_id = ledger_entries.id))`,
      })
      .from(ledgerEntries)
      .innerJoin(students, eq(students.id, ledgerEntries.studentId))
      .where(and(eq(ledgerEntries.tenantId, ctx.tenant.id), campusScopeFilter(ctx, ledgerEntries.studentId)))
      .orderBy(asc(ledgerEntries.studentId), asc(ledgerEntries.effectiveOn), asc(ledgerEntries.entryNumber));
    const byStudent = new Map<string, typeof rows>();
    for (const row of rows)
      (byStudent.get(row.studentId) ?? byStudent.set(row.studentId, []).get(row.studentId)!).push(row);

    const empty = (p: Placement): BalanceGroup => ({
      group: p.group,
      label: p.label,
      students: 0,
      owing: 0,
      owedPesewas: 0,
      creditPesewas: 0,
      buckets: AGE_BUCKETS.map(() => 0),
    });
    const groups = new Map<string, BalanceGroup & { order: string }>();
    const total = empty({ group: "total", label: "Total", order: "" });
    for (const [studentId, lines] of byStudent) {
      const p = placements.get(studentId) ?? NONE;
      const g = groups.get(p.group) ?? { ...empty(p), order: p.order };
      groups.set(p.group, g);
      const balance = sumPesewas(lines.map((l) => l.amountPesewas));
      for (const target of [g, total]) {
        target.students++;
        if (balance > 0) {
          target.owing++;
          target.owedPesewas += balance;
        } else if (balance < 0) target.creditPesewas += -balance;
      }
      if (balance > 0)
        ageOwed(
          lines.filter((l) => !l.paired),
          today,
        ).forEach((amount, i) => {
          g.buckets[i]! += amount;
          total.buckets[i]! += amount;
        });
    }
    return {
      asOf: today,
      groups: [...groups.values()]
        .sort((a, b) => a.order.localeCompare(b.order))
        .map(({ order: _o, ...g }) => g),
      total,
    };
  });
}

const periodSchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .refine((p) => p.from <= p.to, { message: "The start must be before the end.", path: ["from"] })
  .refine((p) => p.to <= addDays(p.from, 400), {
    message: "Choose a period of at most a year.",
    path: ["to"],
  });

export interface CollectionGroup {
  group: string;
  label: string;
  receipts: number;
  totalPesewas: number;
  byMethod: Record<string, number>;
}

/** Money received in a period by class, level or campus, with the split by payment method (FIN-14). */
export async function getCollectionReport(
  database: Database,
  ctx: TenantContext,
  by: Grouping,
  input: unknown,
): Promise<{ from: string; to: string; groups: CollectionGroup[]; total: CollectionGroup }> {
  assertAllowed(ctx, "fees.view");
  const { from, to } = periodSchema.parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    const groupCol = by === "class" ? sql`c.id::text` : by === "level" ? sql`l.id::text` : sql`ca.id::text`;
    const labelCol = by === "class" ? sql`c.name` : by === "level" ? sql`l.name` : sql`ca.name`;
    const orderCol =
      by === "class"
        ? sql`lpad(l.sequence::text, 6, '0') || ' ' || c.name`
        : by === "level"
          ? sql`lpad(l.sequence::text, 6, '0')`
          : sql`ca.name`;
    const campusLimit =
      ctx.campusIds === null
        ? sql`true`
        : sql`ca.id = any(array[${sql.join(
            (ctx.campusIds.length ? ctx.campusIds : ["00000000-0000-0000-0000-000000000000"]).map(
              (id) => sql`${id}`,
            ),
            sql`, `,
          )}]::uuid[])`;
    const rows = await tx.execute<{
      grp: string | null;
      label: string | null;
      ord: string | null;
      method: string;
      receipts: number;
      total: string;
    }>(sql`
      with placed as (
        select p.id, p.method, p.amount_pesewas,
          coalesce(
            (select e.class_id from enrolments e join terms t on t.id = e.term_id
              where e.student_id = p.student_id and p.paid_on between t.starts_on and t.ends_on limit 1),
            (select e.class_id from enrolments e join terms t on t.id = e.term_id and t.is_current
              where e.student_id = p.student_id limit 1)
          ) as class_id
        from payments p
        where p.tenant_id = ${ctx.tenant.id} and p.paid_on between ${from} and ${to}
          and not exists (select 1 from payment_voids v where v.payment_id = p.id)
      )
      select ${groupCol} as grp, ${labelCol} as label, ${orderCol} as ord, placed.method,
        count(*)::int as receipts, sum(placed.amount_pesewas)::text as total
      from placed
      left join classes c on c.id = placed.class_id
      left join levels l on l.id = c.level_id
      left join campuses ca on ca.id = c.campus_id
      where ${ctx.campusIds === null ? sql`true` : sql`(${campusLimit})`}
      group by 1, 2, 3, 4`);
    const groups = new Map<string, CollectionGroup & { order: string }>();
    const total: CollectionGroup = {
      group: "total",
      label: "Total",
      receipts: 0,
      totalPesewas: 0,
      byMethod: {},
    };
    for (const r of rows.rows) {
      const key = r.grp ?? "none";
      const g = groups.get(key) ?? {
        group: key,
        label: r.label ?? NONE.label,
        order: r.ord ?? NONE.order,
        receipts: 0,
        totalPesewas: 0,
        byMethod: {},
      };
      groups.set(key, g);
      for (const target of [g, total]) {
        target.receipts += r.receipts;
        target.totalPesewas += Number(r.total);
        target.byMethod[r.method] = (target.byMethod[r.method] ?? 0) + Number(r.total);
      }
    }
    return {
      from,
      to,
      groups: [...groups.values()]
        .sort((a, b) => a.order.localeCompare(b.order))
        .map(({ order: _o, ...g }) => g),
      total,
    };
  });
}

export interface CategoryLine {
  category: string;
  chargedPesewas: number;
  discountedPesewas: number;
  netPesewas: number;
}

/** What a term billed by fee category: charges, discounts and net (reversed entries left out). */
export async function getBilledByCategory(
  database: Database,
  ctx: TenantContext,
  termId: string,
): Promise<CategoryLine[]> {
  assertAllowed(ctx, "fees.view");
  if (!z.string().uuid().safeParse(termId).success) return [];
  return withTenant(database, scope(ctx), async (tx) => {
    const rows = await tx.execute<{ category: string | null; charged: string; discounted: string }>(sql`
      select fi.category,
        coalesce(sum(l.amount_pesewas) filter (where l.kind = 'charge'), 0)::text as charged,
        coalesce(-sum(l.amount_pesewas) filter (where l.kind = 'discount'), 0)::text as discounted
      from ledger_entries l
      left join fee_items fi on fi.id = l.fee_item_id
      join students s on s.id = l.student_id
      where l.tenant_id = ${ctx.tenant.id} and l.term_id = ${termId} and l.kind in ('charge', 'discount')
        and not exists (select 1 from ledger_entries r where r.reverses_entry_id = l.id)
        and ${campusScopeFilter(ctx, sql.raw("l.student_id") as never) ?? sql`true`}
      group by fi.category order by 2 desc`);
    return rows.rows.map((r) => ({
      category: r.category ?? "other",
      chargedPesewas: Number(r.charged),
      discountedPesewas: Number(r.discounted),
      netPesewas: Number(r.charged) - Number(r.discounted),
    }));
  });
}
