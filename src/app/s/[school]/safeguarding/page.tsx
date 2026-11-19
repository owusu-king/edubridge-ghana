import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusText } from "@/components/ui/badge";
import { PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listCases, listLeads, listMyReports, listReportableStudents } from "@/server/safeguarding/service";
import { formatDateTime, todayIn } from "@/lib/format";
import { CASE_STATUS_LABELS, CONCERN_CATEGORY_LABELS } from "@/lib/safeguarding";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { reportConcernAction } from "./actions";
import { ReportForm } from "./safeguarding-controls";

export const metadata: Metadata = { title: "Safeguarding" };

const TONE = { open: "critical", monitoring: "caution", closed: "neutral" } as const;

/** Reporting a concern (every member of staff), and the cases (the school's safeguarding leads only). */
export default async function SafeguardingPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "safeguarding.report")) notFound();
  const lead = allowed(ctx, "safeguarding.manage");
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const [students, leads, mine, cases] = await Promise.all([
    listReportableStudents(db(), ctx),
    listLeads(db(), ctx),
    listMyReports(db(), ctx),
    lead ? listCases(db(), ctx) : null,
  ]);

  return (
    <div className="space-y-10">
      <PageHeader
        title="Safeguarding"
        description={
          leads.length
            ? `If you are worried about a child, report it here. Only the school's safeguarding ${leads.length === 1 ? "lead" : "leads"}, ${leads.map((l) => l.name).join(" and ")}, will see it. If a child is in immediate danger, act first and tell a lead at once.`
            : "If you are worried about a child, report it here. The school has not appointed a safeguarding lead yet: tell the Proprietor as well."
        }
      />

      {cases && (
        <Section
          title="Cases"
          description="Seen only by the school's safeguarding leads. Every opening is recorded."
        >
          {cases.length === 0 ? (
            <p className="text-base text-ink-3">No cases.</p>
          ) : (
            <TableFrame>
              <Table>
                <caption className="sr-only">Safeguarding cases</caption>
                <THead>
                  <tr>
                    <TH>Case</TH>
                    <TH className="hidden sm:table-cell">Concern</TH>
                    <TH>Status</TH>
                    <TH className="hidden md:table-cell">Lead</TH>
                  </tr>
                </THead>
                <TBody>
                  {cases.map((c) => (
                    <TR key={c.id}>
                      <TD>
                        <Link
                          href={`${schoolPath(slug, "safeguarding")}/${c.id}` as Route}
                          className="font-medium text-ink hover:underline"
                        >
                          {c.reference} · {c.student}
                        </Link>
                        <span className="block text-sm text-ink-3">
                          Reported {formatDateTime(c.reportedAt, tz)}
                        </span>
                      </TD>
                      <TD className="hidden sm:table-cell">{CONCERN_CATEGORY_LABELS[c.category]}</TD>
                      <TD>
                        <StatusText tone={TONE[c.status]}>{CASE_STATUS_LABELS[c.status]}</StatusText>
                        {c.openActions > 0 && (
                          <span className="block text-sm text-ink-3">
                            {c.openActions} {c.openActions === 1 ? "action" : "actions"} to do
                          </span>
                        )}
                      </TD>
                      <TD className="hidden md:table-cell">
                        {c.lead ?? <span className="text-ink-3">Not assigned</span>}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
        </Section>
      )}

      <Section title="Report a concern">
        <ReportForm action={reportConcernAction.bind(null, slug)} students={students} today={todayIn(tz)} />
      </Section>

      {mine.length > 0 && (
        <Section
          title="Your reports"
          description="Received by the safeguarding leads. They follow up; details stay with them."
        >
          <ul className="divide-y divide-line border-y border-line">
            {mine.map((r) => (
              <li key={r.reference} className="py-2.5 text-base text-ink">
                {r.reference} · {r.student}
                <span className="block text-sm text-ink-3">Sent {formatDateTime(r.reportedAt, tz)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
