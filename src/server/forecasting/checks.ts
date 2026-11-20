import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  EARLY_UNTIL_HOUR,
  LARGE_REFUND_MINOR,
  LATE_FROM_HOUR,
  REVIEW_NOTE,
  VOIDS_THRESHOLD,
  type FinanceCheckRule,
} from "../../lib/finance-checks";
import { formatCalendarDate, todayIn } from "../../lib/format";
import { UNBANKED_DAYS } from "../../lib/school-finance";
import { moneyFormatter } from "../../lib/money";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { financeCheckReviews, payments, refunds, mobileMoneyRequests } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import { campusScopeFilter } from "../fees/access";
import { METHOD_LABELS, type PaymentMethod } from "../fees/payments";
import type { TenantContext } from "../tenancy/service";

/**
 * Finance checks (R5-2, FCT-02): rules applied to a term's fee records, each flag saying what it found and linking to
 * the records; the Proprietor or Accountant reviews a flag once with a note, kept (insert-only). The rules and their
 * thresholds are in `src/lib/finance-checks.ts`. Campus-limited people see their campuses' records; reopened periods
 * are school-wide, so only people who see every campus see them.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

/** A link from a flag to a record, as a path under the school. */
export interface FlagLink {
  label: string;
  path: string;
}

export interface FinanceFlag {
  /** Names the flag and the facts it found: changed facts make a new flag. */
  key: string;
  rule: FinanceCheckRule;
  summary: string;
  /** When it happened (the latest record behind it). */
  on: string;
  links: FlagLink[];
  /** False for Mobile Money differences, reviewed on the Mobile Money page. */
  reviewable: boolean;
  review: { note: string; by: string; at: Date } | null;
}

export interface FinanceChecks {
  term: { id: string; label: string; from: string; to: string };
  flags: FinanceFlag[];
}

const where = (filter: SQL | undefined) => filter ?? sql`true`;
const short = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

interface Receipt {
  id: string;
  receipt: string;
}
const receiptLinks = (receipts: Receipt[]): FlagLink[] =>
  receipts.map((r) => ({ label: `Receipt ${r.receipt}`, path: `fees/receipts/${r.id}` }));

async function duplicateReferences(tx: Transaction, ctx: TenantContext, from: string, to: string) {
  const rows = await tx.execute<{
    method: PaymentMethod;
    ref: string;
    shown: string;
    n: number;
    last: string;
    receipts: Receipt[];
  }>(sql`
    select payments.method, lower(btrim(payments.reference)) as ref, count(*)::int as n,
      (array_agg(btrim(payments.reference) order by payments.paid_on, payments.receipt_number))[1] as shown,
      max(payments.paid_on)::text as last,
      json_agg(json_build_object('id', payments.id, 'receipt', payments.receipt_number) order by payments.paid_on, payments.receipt_number) as receipts
    from payments
    left join mobile_money_request_shares share on share.payment_id = payments.id
    where payments.tenant_id = ${ctx.tenant.id} and coalesce(btrim(payments.reference), '') <> ''
      and not exists (select 1 from payment_voids v where v.payment_id = payments.id)
      and ${where(campusScopeFilter(ctx, payments.studentId))}
    group by payments.method, lower(btrim(payments.reference))
    -- A family payment gives each child a receipt with the same transaction: one payment, not a repeat.
    having count(distinct coalesce(share.request_id::text, payments.id::text)) > 1
      and bool_or(payments.paid_on between ${from} and ${to})`);
  return rows.rows.map((r): Omit<FinanceFlag, "review"> => ({
    key: `duplicate_reference:${r.method}:${short(r.ref, 120)}:${r.n}`,
    rule: "duplicate_reference",
    summary: `${r.n} ${METHOD_LABELS[r.method].toLowerCase()} receipts carry the reference “${short(r.shown)}”.`,
    on: r.last,
    links: receiptLinks(r.receipts),
    reviewable: true,
  }));
}

async function manyVoids(tx: Transaction, ctx: TenantContext, termId: string, from: string, to: string) {
  const tz = ctx.tenant.timezone;
  const rows = await tx.execute<{
    user_id: string | null;
    name: string | null;
    n: number;
    last: string;
    receipts: Receipt[];
  }>(sql`
    select v.voided_by_user_id as user_id, u.name, count(*)::int as n,
      max((v.voided_at at time zone ${tz})::date)::text as last,
      json_agg(json_build_object('id', payments.id, 'receipt', payments.receipt_number) order by v.voided_at) as receipts
    from payment_voids v
    join payments on payments.id = v.payment_id
    left join users u on u.id = v.voided_by_user_id
    where v.tenant_id = ${ctx.tenant.id}
      and (v.voided_at at time zone ${tz})::date between ${from} and ${to}
      and ${where(campusScopeFilter(ctx, payments.studentId))}
    group by v.voided_by_user_id, u.name
    having count(*) >= ${VOIDS_THRESHOLD}`);
  return rows.rows.map((r): Omit<FinanceFlag, "review"> => ({
    key: `many_voids:${r.user_id ?? "system"}:${termId}:${r.n}`,
    rule: "many_voids",
    summary: `${r.name ?? "Someone no longer at the school"} voided ${r.n} receipts in the term.`,
    on: r.last,
    links: receiptLinks(r.receipts),
    reviewable: true,
  }));
}

async function outOfHours(tx: Transaction, ctx: TenantContext, from: string, to: string) {
  const tz = ctx.tenant.timezone;
  const rows = await tx.execute<{
    id: string;
    receipt: string;
    name: string | null;
    at: string;
    day: string;
  }>(sql`
    select payments.id, payments.receipt_number as receipt, u.name,
      to_char(payments.recorded_at at time zone ${tz}, 'HH24:MI') as at,
      (payments.recorded_at at time zone ${tz})::date::text as day
    from payments
    left join users u on u.id = payments.recorded_by_user_id
    where payments.tenant_id = ${ctx.tenant.id} and payments.recorded_by_user_id is not null
      and (payments.recorded_at at time zone ${tz})::date between ${from} and ${to}
      and (extract(hour from payments.recorded_at at time zone ${tz}) >= ${LATE_FROM_HOUR}
        or extract(hour from payments.recorded_at at time zone ${tz}) < ${EARLY_UNTIL_HOUR})
      and ${where(campusScopeFilter(ctx, payments.studentId))}
    order by payments.recorded_at`);
  return rows.rows.map((r): Omit<FinanceFlag, "review"> => ({
    key: `out_of_hours:${r.id}`,
    rule: "out_of_hours",
    summary: `Receipt ${r.receipt} was recorded at ${r.at} on ${formatCalendarDate(r.day)}${r.name ? ` by ${r.name}` : ""}.`,
    on: r.day,
    links: receiptLinks([{ id: r.id, receipt: r.receipt }]),
    reviewable: true,
  }));
}

async function momoUnmatched(tx: Transaction, ctx: TenantContext) {
  const tz = ctx.tenant.timezone;
  const rows = await tx.execute<{ id: string; detail: string; day: string }>(sql`
    select i.id, i.detail, (i.created_at at time zone ${tz})::date::text as day
    from reconciliation_items i
    join mobile_money_requests on mobile_money_requests.id = i.request_id
    where i.tenant_id = ${ctx.tenant.id} and i.reviewed_at is null and i.created_at < now() - interval '1 day'
      and ${where(campusScopeFilter(ctx, mobileMoneyRequests.studentId))}
    order by i.created_at`);
  return rows.rows.map((r): Omit<FinanceFlag, "review"> => ({
    key: `momo_unmatched:${r.id}`,
    rule: "momo_unmatched",
    summary: `Open since ${formatCalendarDate(r.day)}: ${short(r.detail, 160)}`,
    on: r.day,
    links: [{ label: "Mobile Money reconciliation", path: "fees/mobile-money/reconciliation" }],
    reviewable: false,
  }));
}

async function largeRefunds(tx: Transaction, ctx: TenantContext, from: string, to: string) {
  const tz = ctx.tenant.timezone;
  const money = moneyFormatter(ctx.tenant.currencyCode);
  const rows = await tx.execute<{
    id: string;
    amount: string;
    status: string;
    name: string | null;
    day: string;
  }>(sql`
    select refunds.id, refunds.amount_pesewas::text as amount, refunds.status, u.name,
      (refunds.requested_at at time zone ${tz})::date::text as day
    from refunds
    left join users u on u.id = refunds.requested_by_user_id
    where refunds.tenant_id = ${ctx.tenant.id} and refunds.amount_pesewas >= ${LARGE_REFUND_MINOR}
      and (refunds.requested_at at time zone ${tz})::date between ${from} and ${to}
      and ${where(campusScopeFilter(ctx, refunds.studentId))}
    order by refunds.requested_at`);
  return rows.rows.map((r): Omit<FinanceFlag, "review"> => ({
    key: `large_refund:${r.id}`,
    rule: "large_refund",
    summary: `A refund of ${money(Number(r.amount))} was requested on ${formatCalendarDate(r.day)}${r.name ? ` by ${r.name}` : ""} (${r.status}).`,
    on: r.day,
    links: [{ label: "Refunds and approvals", path: "fees/approvals" }],
    reviewable: true,
  }));
}

/**
 * Cash and cheques held past the limit, by who recorded them (2026-11-18). Only once the school records deposits (it
 * has a bank account in Finance), so a school that does not bank through EduBridge is not flagged every day.
 */
async function cashNotBanked(tx: Transaction, ctx: TenantContext, to: string) {
  if (ctx.campusIds !== null) return [];
  const money = moneyFormatter(ctx.tenant.currencyCode);
  const rows = await tx.execute<{
    user_id: string | null;
    name: string | null;
    n: number;
    amount: string;
    oldest: string;
  }>(sql`
    select p.recorded_by_user_id as user_id, u.name, count(*)::int as n, sum(p.amount_pesewas)::text as amount,
      min(p.paid_on)::text as oldest
    from payments p
    left join users u on u.id = p.recorded_by_user_id
    where p.tenant_id = ${ctx.tenant.id} and p.method in ('cash', 'cheque')
      and p.paid_on <= (${to}::date - ${UNBANKED_DAYS}::int)
      and exists (select 1 from finance_accounts a where a.tenant_id = ${ctx.tenant.id} and a.kind = 'bank' and a.status = 'active')
      and not exists (select 1 from payment_voids v where v.payment_id = p.id)
      and not exists (select 1 from bank_deposit_items i where i.payment_id = p.id and not i.released)
    group by p.recorded_by_user_id, u.name`);
  return rows.rows.map((r): Omit<FinanceFlag, "review"> => ({
    key: `cash_not_banked:${r.user_id ?? "system"}:${r.n}:${r.amount}`,
    rule: "cash_not_banked",
    summary: `${r.n} cash or cheque receipt${r.n === 1 ? "" : "s"} for ${money(Number(r.amount))}${r.name ? ` recorded by ${r.name}` : ""} not banked; the oldest is from ${formatCalendarDate(r.oldest)}.`,
    on: to,
    links: [{ label: "Cash to bank", path: "finance/deposits" }],
    reviewable: true,
  }));
}

async function reopenedPeriods(tx: Transaction, ctx: TenantContext, from: string, to: string) {
  if (ctx.campusIds !== null) return [];
  const tz = ctx.tenant.timezone;
  const rows = await tx.execute<{
    id: string;
    through: string | null;
    previous: string | null;
    reason: string | null;
    name: string | null;
    day: string;
  }>(sql`
    select * from (
      select l.id, l.locked_through::text as through,
        (lag(l.locked_through) over (order by l.set_at))::text as previous,
        l.reason, u.name, (l.set_at at time zone ${tz})::date::text as day
      from finance_period_locks l left join users u on u.id = l.set_by_user_id
      where l.tenant_id = ${ctx.tenant.id}
    ) h
    where h.previous is not null and (h.through is null or h.through < h.previous)
      and h.day between ${from} and ${to}`);
  return rows.rows.map((r): Omit<FinanceFlag, "review"> => ({
    key: `period_reopened:${r.id}`,
    rule: "period_reopened",
    summary: `${r.name ?? "Someone"} reopened the accounts from ${formatCalendarDate(r.previous!)} ${
      r.through ? `back to ${formatCalendarDate(r.through)}` : "entirely"
    } on ${formatCalendarDate(r.day)}${r.reason ? `: “${short(r.reason, 120)}”` : "."}`,
    on: r.day,
    links: [{ label: "Closing", path: "fees/closing" }],
    reviewable: true,
  }));
}

async function readChecks(
  tx: Transaction,
  ctx: TenantContext,
  termId: string,
): Promise<FinanceChecks | null> {
  if (!/^[0-9a-f-]{36}$/i.test(termId)) return null;
  const [term] = (
    await tx.execute<{ id: string; label: string; starts_on: string; ends_on: string }>(sql`
      select t.id, t.name || ', ' || y.name as label, t.starts_on::text, t.ends_on::text
      from terms t join academic_years y on y.id = t.academic_year_id
      where t.tenant_id = ${ctx.tenant.id} and t.id = ${termId}`)
  ).rows;
  if (!term) return null;
  const today = todayIn(ctx.tenant.timezone);
  const from = term.starts_on;
  const to = term.ends_on < today ? term.ends_on : today;
  const found = [
    ...(await duplicateReferences(tx, ctx, from, to)),
    ...(await manyVoids(tx, ctx, term.id, from, to)),
    ...(await outOfHours(tx, ctx, from, to)),
    ...(await momoUnmatched(tx, ctx)),
    ...(await largeRefunds(tx, ctx, from, to)),
    ...(await reopenedPeriods(tx, ctx, from, to)),
    ...(await cashNotBanked(tx, ctx, to)),
  ];
  const reviews = found.length
    ? (
        await tx.execute<{ key: string; note: string; name: string | null; at: Date }>(sql`
          select r.check_key as key, r.note, u.name, r.reviewed_at as at
          from finance_check_reviews r left join users u on u.id = r.reviewed_by_user_id
          where r.tenant_id = ${ctx.tenant.id}
            and r.check_key in (${sql.join(
              found.map((f) => sql`${f.key}`),
              sql`, `,
            )})`)
      ).rows
    : [];
  const byKey = new Map(reviews.map((r) => [r.key, r]));
  return {
    term: { id: term.id, label: term.label, from, to },
    flags: found.map((f) => {
      const r = byKey.get(f.key);
      return { ...f, review: r ? { note: r.note, by: r.name ?? "Someone", at: new Date(r.at) } : null };
    }),
  };
}

/** The finance checks for a term's dates (to today), every rule, with their reviews. Null when no such term. */
export async function listFinanceChecks(
  database: Database,
  ctx: TenantContext,
  termId: string,
): Promise<FinanceChecks | null> {
  assertAllowed(ctx, "finance_checks.review");
  return withTenant(database, scope(ctx), (tx) => readChecks(tx, ctx, termId));
}

const reviewInput = z.object({
  termId: z.string().uuid(),
  key: z.string().min(3).max(300),
  note: z
    .string()
    .trim()
    .min(REVIEW_NOTE.min, "Say what you found, or why it is fine.")
    .max(REVIEW_NOTE.max, `Keep the note to ${REVIEW_NOTE.max} characters.`),
});

/** Reviews a flag the person can see, once, with a note (FCT-02b); audited. */
export async function reviewFinanceCheck(
  database: Database,
  ctx: TenantContext,
  input: Record<string, unknown>,
): Promise<void> {
  assertAllowed(ctx, "finance_checks.review");
  const parsed = reviewInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new DomainError("review_invalid", issue.message, String(issue.path[0] ?? "note"));
  }
  const { termId, key, note } = parsed.data;
  await withTenant(database, scope(ctx), async (tx) => {
    const checks = await readChecks(tx, ctx, termId);
    const flag = checks?.flags.find((f) => f.key === key);
    if (!flag) throw new DomainError("check_not_found", "This flag is no longer raised. Reload the page.");
    if (!flag.reviewable)
      throw new DomainError("check_not_reviewable", "Review Mobile Money differences under Mobile Money.");
    if (flag.review) throw new DomainError("check_already_reviewed", "This flag has already been reviewed.");
    try {
      const [row] = await tx
        .insert(financeCheckReviews)
        .values({
          tenantId: ctx.tenant.id,
          checkKey: key,
          rule: flag.rule,
          note,
          reviewedByUserId: ctx.userId,
        })
        .returning({ id: financeCheckReviews.id });
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "finance_check.reviewed",
        entityType: "finance_check_review",
        entityId: row!.id,
        metadata: { rule: flag.rule, summary: flag.summary },
      });
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
        throw new DomainError("check_already_reviewed", "This flag has already been reviewed.");
      throw error;
    }
  });
}
