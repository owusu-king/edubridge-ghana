import type { Metadata, Route } from "next";
import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { db } from "@/server/db/client";
import { listSupportPlans } from "@/server/early-warning/plans";
import { formatCalendarDate } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export const metadata: Metadata = { title: "Early warning · Support plans" };

/** Support plans (R5-3, EWS-03) for the students the person looks after: open ones first, soonest review first. */
export default async function SupportPlansPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const plans = await listSupportPlans(db(), ctx);
  const open = plans.filter((p) => !p.closed);
  return (
    <Section
      title="Support plans"
      description={`${open.length} open. A plan is opened from a review; updates are added to it, and it is closed once with how it went.`}
    >
      {plans.length === 0 ? (
        <EmptyState
          icon={<ClipboardList />}
          title="No support plans yet"
          description="When a review opens a support plan, it is listed here with its review date."
        />
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Support plans</caption>
            <THead>
              <tr>
                <TH>Student</TH>
                <TH>Goal</TH>
                <TH className="hidden md:table-cell">Responsible</TH>
                <TH>Review</TH>
              </tr>
            </THead>
            <TBody>
              {plans.map((p) => (
                <TR key={p.id}>
                  <TD>
                    <Link
                      href={schoolPath(slug, `early-warning/plans/${p.id}`) as Route}
                      className="font-medium text-ink hover:text-accent hover:underline"
                    >
                      {p.student.name}
                    </Link>
                    <span className="block text-sm text-ink-3">{p.student.className}</span>
                  </TD>
                  <TD className="text-ink-2">{p.goal}</TD>
                  <TD className="hidden text-ink-2 md:table-cell">{p.responsible}</TD>
                  <TD>
                    {p.closed ? (
                      <Badge>Closed</Badge>
                    ) : (
                      <span className="flex flex-wrap items-center gap-2 tabular-nums">
                        {formatCalendarDate(p.reviewOn)}
                        {p.overdue && <Badge tone="caution">Overdue</Badge>}
                      </span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </Section>
  );
}
