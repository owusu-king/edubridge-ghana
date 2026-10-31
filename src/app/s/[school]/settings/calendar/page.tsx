import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarDays } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { StatusText } from "@/components/ui/badge";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { listAcademicYears, suggestedYear } from "@/server/academics/calendar";
import { can } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { formatCalendarDate } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { createYearAction, makeCurrentAction, updateTermAction } from "./actions";
import { AddYearDialog, TermActions } from "./calendar-controls";

export const metadata: Metadata = { title: "Settings · Calendar" };

export default async function CalendarPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "academics.manage")) notFound();
  const years = await listAcademicYears(db(), ctx);
  const slug = ctx.tenant.slug;
  const hasCurrent = years.some((y) => y.terms.some((t) => t.isCurrent));
  const add = (
    <AddYearDialog action={createYearAction.bind(null, slug)} suggestedName={suggestedYear().name} />
  );

  return (
    <Section
      title="Academic calendar"
      description="Years and terms. Fees, attendance and reports follow the current term."
      aside={years.length > 0 && add}
    >
      {years.length === 0 ? (
        <EmptyState
          icon={<CalendarDays />}
          title="No academic years yet"
          description="Add your school year and its term dates to get started."
          action={add}
        />
      ) : (
        <div className="space-y-8">
          {!hasCurrent && (
            <Alert tone="info">Choose the current term so fees and attendance use the right dates.</Alert>
          )}
          {years.map((year) => (
            <div key={year.id} className="space-y-3">
              <h3 className="text-base font-semibold text-ink">
                {year.name}{" "}
                <span className="font-normal text-ink-3">
                  · {formatCalendarDate(year.startsOn)} – {formatCalendarDate(year.endsOn)}
                </span>
              </h3>
              <TableFrame>
                <Table>
                  <caption className="sr-only">Terms in {year.name}</caption>
                  <THead>
                    <tr>
                      <TH>Term</TH>
                      <TH>Starts</TH>
                      <TH>Ends</TH>
                      <TH className="hidden sm:table-cell">Status</TH>
                      <TH>
                        <span className="sr-only">Actions</span>
                      </TH>
                    </tr>
                  </THead>
                  <TBody>
                    {year.terms.map((term) => (
                      <TR key={term.id}>
                        <TD className="font-medium text-ink">{term.name}</TD>
                        <TD className="whitespace-nowrap">{formatCalendarDate(term.startsOn)}</TD>
                        <TD className="whitespace-nowrap">{formatCalendarDate(term.endsOn)}</TD>
                        <TD className="hidden sm:table-cell">
                          {term.isCurrent ? <StatusText tone="positive">Current</StatusText> : null}
                        </TD>
                        <TD>
                          <TermActions
                            term={term}
                            update={updateTermAction.bind(null, slug, term.id)}
                            makeCurrent={makeCurrentAction.bind(null, slug, term.id)}
                          />
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableFrame>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
