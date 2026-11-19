import type { Metadata, Route } from "next";
import Link from "next/link";
import { CalendarDays, LifeBuoy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Section } from "@/components/ui/layout";
import { db } from "@/server/db/client";
import { getEarlyWarning, type Indicator } from "@/server/early-warning/indicators";
import { OUTCOME_LABELS, REVIEW_WITHIN_DAYS, RULE_LABELS } from "@/lib/early-warning";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { openPlanAction, reviewIndicatorAction } from "./actions";
import { OpenPlanDialog, ReviewIndicatorDialog } from "./controls";

export const metadata: Metadata = { title: "Early warning" };

/**
 * Early-warning indicators (R5-3, EWS-01, EWS-02): what this term's records show for the classes the person looks
 * after, each with its evidence, for the class teacher or Head teacher to review.
 */
export default async function EarlyWarningPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const ew = await getEarlyWarning(db(), ctx);
  if (!ew.term)
    return (
      <EmptyState
        icon={<CalendarDays />}
        title="No current term"
        description="Indicators come from the current term's registers and report cards. Mark the current term in Settings, Calendar."
      />
    );
  const toReview = ew.indicators.filter((i) => !i.review);
  const reviewed = ew.indicators.filter((i) => i.review);
  const waiting = toReview.filter((i) => i.waiting);
  // Academic leads see the waiting ones in their own section above.
  const rest = toReview.filter((i) => !(ew.seesAll && i.waiting));
  const referrals = ew.referrals.filter((r) => !r.planOpened);
  const tz = ctx.tenant.timezone;
  // Teachers refer to the Head teacher; academic leads act themselves.
  const canRefer = !ew.seesAll;

  const row = (i: Indicator) => (
    <li key={i.key} className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            href={schoolPath(slug, `students/${i.student.id}`) as Route}
            className="font-semibold text-ink hover:text-accent hover:underline"
          >
            {i.student.name}
          </Link>
          <span className="text-sm text-ink-3">{i.student.className}</span>
          {i.waiting && <Badge tone="caution">Waiting over {REVIEW_WITHIN_DAYS} days</Badge>}
        </p>
        <p className="text-sm font-medium text-ink-2">{RULE_LABELS[i.rule]}</p>
        {i.evidence.map((e) => (
          <p key={e} className="text-base text-ink-2">
            {e}
          </p>
        ))}
        <p className="text-sm text-ink-3">Raised {formatCalendarDate(i.raisedOn)}</p>
        {i.review && (
          <p className="text-sm text-ink-2">
            <span className="font-medium text-ink">{OUTCOME_LABELS[i.review.outcome]}</span>, by {i.review.by}
            , {formatDateTime(i.review.at, tz)}: {i.review.reason}
            {i.review.supportPlanId && (
              <>
                {" "}
                <Link
                  href={schoolPath(slug, `early-warning/plans/${i.review.supportPlanId}`) as Route}
                  className="text-accent hover:underline"
                >
                  See the plan
                </Link>
              </>
            )}
          </p>
        )}
      </div>
      <div className="sm:justify-self-end">
        {!i.review && ew.canReview && (
          <ReviewIndicatorDialog
            action={reviewIndicatorAction.bind(null, slug, i.key)}
            summary={`${i.student.name}: ${RULE_LABELS[i.rule].toLowerCase()}`}
            today={ew.today}
            canRefer={canRefer}
          />
        )}
      </div>
    </li>
  );

  return (
    <div className="space-y-12">
      {ew.seesAll && ew.canReview && referrals.length > 0 && (
        <Section
          title="Referred to you"
          description="Teachers asked the Head teacher to act. Open a plan, or talk to the teacher."
        >
          <ul className="divide-y divide-line border-y border-line">
            {referrals.map((r) => (
              <li
                key={r.reviewId}
                className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
              >
                <div className="min-w-0 space-y-1">
                  <p className="flex flex-wrap items-center gap-x-2">
                    <Link
                      href={schoolPath(slug, `students/${r.student.id}`) as Route}
                      className="font-semibold text-ink hover:text-accent hover:underline"
                    >
                      {r.student.name}
                    </Link>
                    <span className="text-sm text-ink-3">{r.student.className}</span>
                  </p>
                  <p className="text-sm font-medium text-ink-2">{RULE_LABELS[r.rule]}</p>
                  <p className="text-base text-ink-2">
                    {r.by}, {formatDateTime(r.at, tz)}: {r.reason}
                  </p>
                </div>
                <div className="sm:justify-self-end">
                  <OpenPlanDialog
                    action={openPlanAction.bind(null, slug, r.student.id)}
                    studentName={r.student.name}
                    today={ew.today}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {ew.seesAll && waiting.length > 0 && (
        <Section
          title={`Waiting more than ${REVIEW_WITHIN_DAYS} days`}
          description="Raised over a week ago and not yet reviewed by the class teacher."
        >
          <ul className="divide-y divide-line border-y border-line">{waiting.map(row)}</ul>
        </Section>
      )}

      <Section
        title="To review"
        description={`${ew.term.label}. ${ew.seesAll ? "Every class you oversee." : "The classes you are class teacher of."} Each says what the records show; "may need support" is never a label.`}
      >
        {toReview.length === 0 ? (
          <EmptyState
            icon={<LifeBuoy />}
            title="Nothing to review"
            description="No student's records meet the school's rules at the moment, or every indicator has been reviewed."
          />
        ) : rest.length === 0 ? (
          <p className="text-base text-ink-2">Every indicator to review is listed above, as waiting.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">{rest.map(row)}</ul>
        )}
      </Section>

      {reviewed.length > 0 && (
        <Section title="Reviewed this term" description="Reviews are kept as written.">
          <ul className="divide-y divide-line border-y border-line">{reviewed.map(row)}</ul>
        </Section>
      )}
    </div>
  );
}
