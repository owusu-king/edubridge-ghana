import type { Metadata, Route } from "next";
import Link from "next/link";
import { FileDown } from "lucide-react";
import { buttonStyles } from "@/components/ui/button";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { listCampuses } from "@/server/campuses/service";
import { db } from "@/server/db/client";
import { narrowToCampus } from "@/server/fees/access";
import { METHOD_LABELS } from "@/server/fees/payments";
import {
  getBalanceReport,
  getBilledByCategory,
  getCollectionReport,
  GROUPINGS,
  type Grouping,
} from "@/server/fees/reports";
import { FEE_CATEGORY_LABELS, listFeeTerms, type FeeCategory } from "@/server/fees/structure";
import { addDays } from "@/lib/attendance";
import { AGE_BUCKETS } from "@/lib/dashboard";
import { todayIn } from "@/lib/format";
import { moneyFormatter } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export const metadata: Metadata = { title: "Fees · Reports" };

const GROUP_LABELS: Record<Grouping, string> = { class: "Class", level: "Level", campus: "Campus" };
const isDate = (v?: string) => Boolean(v && /^\d{4}-\d{2}-\d{2}$/.test(v));

/**
 * Finance reports (FIN-13, FIN-14): what is owed and for how long, and what came in, by class, level or
 * campus; and what a term billed by category. Totals reconcile with Fees, Owing and the Overview.
 */
export default async function FeeReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ by?: string; from?: string; to?: string; term?: string; campus?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx: full } = await requireTenant(school);
  const showMoney = moneyFormatter(full.tenant.currencyCode);
  const slug = full.tenant.slug;
  const campuses = (await listCampuses(db(), full)).filter((c) => c.status === "active");
  // One campus (OVR-01): the same scope as a member of that campus, so totals match the overview.
  const ctx = narrowToCampus(full, campuses.length > 1 ? search.campus : null);
  const campusId = ctx === full ? null : search.campus!;
  const by: Grouping = (GROUPINGS as readonly string[]).includes(search.by ?? "")
    ? (search.by as Grouping)
    : "class";
  const today = todayIn(ctx.tenant.timezone);
  const to = isDate(search.to) ? search.to! : today;
  const from = isDate(search.from) ? search.from! : addDays(to, -30);
  const terms = await listFeeTerms(db(), ctx);
  const termId =
    terms.find((t) => t.id === search.term)?.id ?? terms.find((t) => t.isCurrent)?.id ?? terms[0]?.id;
  const [balances, collections, categories] = await Promise.all([
    getBalanceReport(db(), ctx, by),
    getCollectionReport(db(), ctx, by, { from, to }).catch(() => null),
    termId ? getBilledByCategory(db(), ctx, termId) : [],
  ]);
  const methods = collections ? Object.keys(collections.total.byMethod) : [];
  const query = (extra: Record<string, string>) =>
    `?${new URLSearchParams({ by, from, to, ...(termId ? { term: termId } : {}), ...(campusId ? { campus: campusId } : {}), ...extra }).toString()}`;
  const csv = (report: string) => `${schoolPath(slug, "fees/reports/export")}${query({ report })}`;

  return (
    <div className="space-y-12">
      <form method="get" className="flex flex-wrap items-end gap-4" aria-label="Report options">
        <label className="space-y-1 text-sm text-ink-2">
          <span className="block font-medium text-ink">Group by</span>
          <select
            name="by"
            defaultValue={by}
            className="h-10 rounded-md border border-line-strong bg-surface px-3 text-base"
          >
            {GROUPINGS.map((g) => (
              <option key={g} value={g}>
                {GROUP_LABELS[g]}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm text-ink-2">
          <span className="block font-medium text-ink">Collections from</span>
          <input
            type="date"
            name="from"
            defaultValue={from}
            className="h-10 rounded-md border border-line-strong bg-surface px-3 text-base"
          />
        </label>
        <label className="space-y-1 text-sm text-ink-2">
          <span className="block font-medium text-ink">to</span>
          <input
            type="date"
            name="to"
            defaultValue={to}
            className="h-10 rounded-md border border-line-strong bg-surface px-3 text-base"
          />
        </label>
        {terms.length > 0 && (
          <label className="space-y-1 text-sm text-ink-2">
            <span className="block font-medium text-ink">Term (billed by category)</span>
            <select
              name="term"
              defaultValue={termId}
              className="h-10 rounded-md border border-line-strong bg-surface px-3 text-base"
            >
              {terms.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}, {t.yearName}
                </option>
              ))}
            </select>
          </label>
        )}
        {campuses.length > 1 && (
          <label className="space-y-1 text-sm text-ink-2">
            <span className="block font-medium text-ink">Campus</span>
            <select
              name="campus"
              defaultValue={campusId ?? ""}
              className="h-10 rounded-md border border-line-strong bg-surface px-3 text-base"
            >
              <option value="">All campuses</option>
              {campuses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" className={buttonStyles("secondary")}>
          Show
        </button>
      </form>

      <Section
        title={`Owed today by ${GROUP_LABELS[by].toLowerCase()}`}
        description="Balances as of today, aged from the oldest unpaid charge. Students are grouped by their class this term."
        aside={
          <Link
            href={csv("balances") as Route}
            className={buttonStyles("secondary", "sm")}
            aria-label="Download owed today as CSV"
          >
            <FileDown aria-hidden="true" className="size-4" />
            CSV
          </Link>
        }
      >
        <TableFrame>
          <Table>
            <THead>
              <tr>
                <TH>{GROUP_LABELS[by]}</TH>
                <TH numeric>Students owing</TH>
                <TH numeric>Owed</TH>
                {AGE_BUCKETS.map((b) => (
                  <TH key={b.label} numeric>
                    {b.label}
                  </TH>
                ))}
                <TH numeric>In credit</TH>
              </tr>
            </THead>
            <TBody>
              {[...balances.groups, balances.total].map((g) => (
                <TR key={g.group}>
                  <TD className={g.group === "total" ? "font-semibold text-ink" : "text-ink"}>{g.label}</TD>
                  <TD numeric>
                    {g.owing} of {g.students}
                  </TD>
                  <TD numeric className={g.group === "total" ? "font-semibold" : undefined}>
                    {showMoney(g.owedPesewas)}
                  </TD>
                  {g.buckets.map((v, i) => (
                    <TD key={i} numeric>
                      {showMoney(v)}
                    </TD>
                  ))}
                  <TD numeric>{showMoney(g.creditPesewas)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      </Section>

      <Section
        title={`Collected by ${GROUP_LABELS[by].toLowerCase()}`}
        description={`Receipts not voided, ${from} to ${to}, by the class the student was in on the payment date.`}
        aside={
          collections && (
            <Link
              href={csv("collections") as Route}
              className={buttonStyles("secondary", "sm")}
              aria-label="Download collections as CSV"
            >
              <FileDown aria-hidden="true" className="size-4" />
              CSV
            </Link>
          )
        }
      >
        {!collections ? (
          <p className="text-sm text-critical">
            Choose a period of at most a year, with the start before the end.
          </p>
        ) : collections.groups.length === 0 ? (
          <p className="text-base text-ink-2">Nothing was received in this period.</p>
        ) : (
          <TableFrame>
            <Table>
              <THead>
                <tr>
                  <TH>{GROUP_LABELS[by]}</TH>
                  <TH numeric>Receipts</TH>
                  {methods.map((m) => (
                    <TH key={m} numeric>
                      {METHOD_LABELS[m as keyof typeof METHOD_LABELS] ?? m}
                    </TH>
                  ))}
                  <TH numeric>Total</TH>
                </tr>
              </THead>
              <TBody>
                {[...collections.groups, collections.total].map((g) => (
                  <TR key={g.group}>
                    <TD className={g.group === "total" ? "font-semibold text-ink" : "text-ink"}>{g.label}</TD>
                    <TD numeric>{g.receipts}</TD>
                    {methods.map((m) => (
                      <TD key={m} numeric>
                        {showMoney(g.byMethod[m] ?? 0)}
                      </TD>
                    ))}
                    <TD numeric className={g.group === "total" ? "font-semibold" : undefined}>
                      {showMoney(g.totalPesewas)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>

      <Section
        title="Billed by category"
        description="What the term billed, by the category of each fee item (set under Fee items). Reversed charges are left out."
      >
        {categories.length === 0 ? (
          <p className="text-base text-ink-2">Nothing billed for this term yet.</p>
        ) : (
          <TableFrame>
            <Table>
              <THead>
                <tr>
                  <TH>Category</TH>
                  <TH numeric>Charged</TH>
                  <TH numeric>Discounts</TH>
                  <TH numeric>Net</TH>
                </tr>
              </THead>
              <TBody>
                {categories.map((c) => (
                  <TR key={c.category}>
                    <TD className="text-ink">
                      {FEE_CATEGORY_LABELS[c.category as FeeCategory] ?? c.category}
                    </TD>
                    <TD numeric>{showMoney(c.chargedPesewas)}</TD>
                    <TD numeric>{showMoney(c.discountedPesewas)}</TD>
                    <TD numeric>{showMoney(c.netPesewas)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>
    </div>
  );
}
