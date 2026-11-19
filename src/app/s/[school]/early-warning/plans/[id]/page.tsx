import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { DescriptionList, Section } from "@/components/ui/layout";
import { db } from "@/server/db/client";
import { getSupportPlan } from "@/server/early-warning/plans";
import { RULE_LABELS, type EarlyWarningRule } from "@/lib/early-warning";
import { formatCalendarDate, formatDateTime, todayIn } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { addPlanUpdateAction, closePlanAction } from "../../actions";
import { ClosePlanDialog, PlanUpdateDialog } from "../../controls";

export const metadata: Metadata = { title: "Early warning · Support plan" };

/** One support plan (EWS-03): what it is for, what was decided, and everything added since. */
export default async function SupportPlanPage({
  params,
}: {
  params: Promise<{ school: string; id: string }>;
}) {
  const { school, id } = await params;
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const plan = await getSupportPlan(db(), ctx, id);
  if (!plan) notFound();
  const tz = ctx.tenant.timezone;
  return (
    <div className="space-y-10">
      <Section
        title={`Support plan for ${plan.student.name}`}
        description={`${plan.student.className}. Opened by ${plan.openedBy}, ${formatDateTime(plan.openedAt, tz)}.`}
        aside={
          <Link
            href={schoolPath(slug, "early-warning/plans") as Route}
            className="text-sm font-medium text-accent hover:underline"
          >
            All plans
          </Link>
        }
      >
        <DescriptionList
          items={[
            { term: "Goal", detail: plan.goal },
            {
              term: "What will be done",
              detail: <span className="whitespace-pre-line">{plan.actions}</span>,
            },
            { term: "Who is responsible", detail: plan.responsible },
            {
              term: "Review",
              detail: plan.closed ? (
                <Badge>Closed</Badge>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  {formatCalendarDate(plan.reviewOn)}
                  {plan.overdue && <Badge tone="caution">Overdue</Badge>}
                </span>
              ),
            },
            ...(plan.closed
              ? [
                  {
                    term: "Outcome",
                    detail: `${plan.outcome} (closed by ${plan.closedBy ?? "someone"}, ${formatDateTime(plan.closedAt!, tz)})`,
                  },
                ]
              : []),
          ]}
        />
        {plan.canChange && (
          <div className="flex flex-wrap gap-2">
            <PlanUpdateDialog action={addPlanUpdateAction.bind(null, slug, plan.id)} today={todayIn(tz)} />
            <ClosePlanDialog action={closePlanAction.bind(null, slug, plan.id)} />
          </div>
        )}
      </Section>

      <Section title="History" description="Everything added to the plan, as written.">
        <ol className="divide-y divide-line border-y border-line">
          {plan.reasons.map((r) => (
            <li key={`r-${r.at.toISOString()}`} className="space-y-1 py-3">
              <p className="text-sm text-ink-3">
                {formatDateTime(r.at, tz)} · {r.by} · review of “{RULE_LABELS[r.rule as EarlyWarningRule]}”
              </p>
              <p className="text-base text-ink">{r.reason}</p>
            </li>
          ))}
          <li className="space-y-1 py-3">
            <p className="text-sm text-ink-3">
              {formatDateTime(plan.openedAt, tz)} · {plan.openedBy}
            </p>
            <p className="text-base text-ink">Plan opened.</p>
          </li>
          {plan.updates.map((u) => (
            <li key={u.id} className="space-y-1 py-3">
              <p className="text-sm text-ink-3">
                {formatDateTime(u.at, tz)} · {u.by}
                {u.reviewOn ? ` · next review ${formatCalendarDate(u.reviewOn)}` : ""}
              </p>
              <p className="text-base whitespace-pre-line text-ink">{u.note}</p>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}
