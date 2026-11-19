import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/ui/action-forms";
import { Section } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listAppointableMembers, listLeads } from "@/server/safeguarding/service";
import { formatCalendarDate } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { appointLeadAction, endLeadAction } from "../../safeguarding/actions";
import { AppointLeadForm } from "../../safeguarding/safeguarding-controls";

export const metadata: Metadata = { title: "Settings · Safeguarding" };

/** The Proprietor appoints the school's designated safeguarding leads (SFG-01b, D-R4-6). */
export default async function SafeguardingSettingsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "safeguarding.appoint")) notFound();
  const slug = ctx.tenant.slug;
  const [leads, members] = await Promise.all([listLeads(db(), ctx), listAppointableMembers(db(), ctx)]);

  return (
    <Section
      title="Safeguarding leads"
      description="Only these people see safeguarding cases: nobody else at the school, including you unless you appoint yourself, and never EduBridge. Ending an appointment takes their access away at once; cases stay."
    >
      {leads.length === 0 ? (
        <p className="text-base text-ink-3">
          No leads yet. Staff can still report concerns; appoint at least one lead to handle them.
        </p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {leads.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-3 py-3">
              <span>
                <span className="block text-base text-ink">{l.name}</span>
                <span className="text-sm text-ink-3">
                  {l.email} · lead since {formatCalendarDate(l.since.toISOString().slice(0, 10))}
                </span>
              </span>
              <ActionButton
                action={endLeadAction.bind(null, slug, l.id)}
                label="End"
                ariaLabel={`End ${l.name} as a lead`}
              />
            </li>
          ))}
        </ul>
      )}
      <AppointLeadForm action={appointLeadAction.bind(null, slug)} members={members} />
    </Section>
  );
}
