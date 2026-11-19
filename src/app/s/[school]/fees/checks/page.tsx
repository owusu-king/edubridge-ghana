import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarDays, Check } from "lucide-react";
import { TermPicker } from "@/components/term-picker";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Section } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listFinanceChecks, type FinanceFlag } from "@/server/forecasting/checks";
import { FINANCE_CHECK_LABELS, FINANCE_CHECK_RULES } from "@/lib/finance-checks";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { chooseTerm } from "@/web/terms";
import { reviewFinanceCheckAction } from "../finance-actions";
import { CheckReviewDialog } from "./check-review-dialog";

export const metadata: Metadata = { title: "Fees · Checks" };

/**
 * Finance checks (R5-2, FCT-02): every rule, run over the chosen term's dates, with what it found and links to the
 * records. The Proprietor or Accountant reviews each flag once with a note, which is kept.
 */
export default async function FinanceChecksPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ term?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "finance_checks.review")) notFound();
  const slug = ctx.tenant.slug;
  const { terms, term } = await chooseTerm(ctx, search.term);
  const checks = term ? await listFinanceChecks(db(), ctx, term.id) : null;
  if (!term || !checks)
    return (
      <Section title="Finance checks">
        <EmptyState
          icon={<CalendarDays />}
          title="No terms yet"
          description="Set up the academic year and its terms in Settings, Calendar; checks run over a term's dates."
        />
      </Section>
    );
  const waiting = checks.flags.filter((f) => f.reviewable && !f.review).length;

  return (
    <div className="space-y-8">
      {terms.length > 1 && (
        <div className="flex justify-end">
          <TermPicker terms={terms} termId={term.id} />
        </div>
      )}
      <Section
        title="Finance checks"
        description={`${checks.term.label}: ${formatCalendarDate(checks.term.from)} to ${formatCalendarDate(checks.term.to)}. Rules that point out what someone should look at; a flag is not an accusation. ${
          waiting === 0
            ? "Nothing is waiting for a review."
            : `${waiting} ${waiting === 1 ? "flag is" : "flags are"} waiting for a review.`
        }`}
      >
        <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {FINANCE_CHECK_RULES.filter((rule) => rule !== "period_reopened" || ctx.campusIds === null).map(
            (rule) => {
              const flags = checks.flags.filter((f) => f.rule === rule);
              const label = FINANCE_CHECK_LABELS[rule];
              const open = flags.filter((f) => !f.review).length;
              return (
                <section key={rule} aria-labelledby={`rule-${rule}`} className="space-y-3 px-4 py-5 sm:px-6">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h2 id={`rule-${rule}`} className="text-md font-semibold text-ink">
                      {label.title}
                    </h2>
                    {flags.length > 0 &&
                      (open > 0 ? (
                        <Badge tone="caution">{open} to look at</Badge>
                      ) : (
                        <Badge>{flags.length} reviewed</Badge>
                      ))}
                  </div>
                  <p className="text-sm text-ink-2">{label.why}</p>
                  {flags.length === 0 ? (
                    <p className="flex items-center gap-1.5 text-sm text-ink-3">
                      <Check aria-hidden="true" className="size-3.5 text-positive" />
                      Nothing found.
                    </p>
                  ) : (
                    <ul className="divide-y divide-line border-y border-line">
                      {flags.map((flag) => (
                        <FlagRow
                          key={flag.key}
                          flag={flag}
                          slug={slug}
                          termId={term.id}
                          timeZone={ctx.tenant.timezone}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              );
            },
          )}
        </div>
      </Section>
    </div>
  );
}

function FlagRow({
  flag,
  slug,
  termId,
  timeZone,
}: {
  flag: FinanceFlag;
  slug: string;
  termId: string;
  timeZone: string;
}) {
  return (
    <li className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0 space-y-1">
        <p className="text-base text-ink">{flag.summary}</p>
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          {flag.links.map((l) => (
            <Link
              key={l.path + l.label}
              href={schoolPath(slug, l.path) as Route}
              className="text-accent hover:underline"
            >
              {l.label}
            </Link>
          ))}
        </p>
        {flag.review && (
          <p className="text-sm text-ink-2">
            <span className="font-medium text-ink">Reviewed</span> by {flag.review.by},{" "}
            {formatDateTime(flag.review.at, timeZone)}: {flag.review.note}
          </p>
        )}
      </div>
      <div className="sm:justify-self-end">
        {flag.review ? (
          <Badge tone="positive">Reviewed</Badge>
        ) : flag.reviewable ? (
          <CheckReviewDialog
            action={reviewFinanceCheckAction.bind(null, slug, termId, flag.key)}
            summary={flag.summary}
          />
        ) : (
          <p className="max-w-48 text-sm text-ink-3">Reviewed under Mobile Money.</p>
        )}
      </div>
    </li>
  );
}
