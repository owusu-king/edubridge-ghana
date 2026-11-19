import type { Metadata } from "next";
import { Section } from "@/components/ui/layout";
import { DateForm } from "@/components/fees/finance-forms";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getPeriodLock } from "@/server/fees/period-lock";
import { addDays } from "@/lib/attendance";
import { formatDateTime, todayIn } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { closePeriodAction, reopenPeriodAction } from "../finance-actions";

export const metadata: Metadata = { title: "Fees · Closing" };

/** Closing the books (FIN-16): nothing can be posted or paid with a date in a closed period. */
export default async function ClosingPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const lock = await getPeriodLock(db(), ctx);
  const today = todayIn(ctx.tenant.timezone);
  const when = (d: Date) => formatDateTime(d, ctx.tenant.timezone);
  return (
    <div className="space-y-12">
      <Section
        title="Closing the books"
        description="Once a month or term is closed, no charge, discount, payment or adjustment can be dated on or before the closing date, from any screen. Corrections go into an open period: voids and reversals are dated the day they are made."
      >
        <p className="text-base text-ink">
          {lock.lockedThrough ? (
            <>
              The books are closed up to <strong>{lock.lockedThrough}</strong>.
            </>
          ) : (
            "No period is closed."
          )}
        </p>
        {allowed(ctx, "fees.close_periods") && (
          <DateForm
            action={closePeriodAction.bind(null, ctx.tenant.slug)}
            label="Close the books up to"
            submitLabel="Close period"
            defaultValue={addDays(today, -1)}
          />
        )}
      </Section>
      {allowed(ctx, "fees.reopen_periods") && lock.lockedThrough && (
        <Section
          title="Reopen"
          description="Only the Proprietor can reopen a closed period, with a reason. Leave the date empty to reopen everything."
        >
          <DateForm
            action={reopenPeriodAction.bind(null, ctx.tenant.slug)}
            label="Keep closed up to (optional)"
            submitLabel="Reopen"
            withReason
            optional
          />
        </Section>
      )}
      <Section title="History">
        {lock.history.length === 0 ? (
          <p className="text-sm text-ink-3">The books have never been closed.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line text-sm">
            {lock.history.map((h, i) => (
              <li key={i} className="flex flex-wrap justify-between gap-3 py-2">
                <span className="text-ink">
                  {h.lockedThrough ? `Closed up to ${h.lockedThrough}` : "Reopened everything"}
                  {h.reason ? `: ${h.reason}` : ""}
                </span>
                <span className="text-ink-3">
                  {h.by} · {when(h.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
