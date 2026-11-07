import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarDays } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { StatusText } from "@/components/ui/badge";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { listAcademicYears, suggestedYear } from "@/server/academics/calendar";
import { listHolidays } from "@/server/academics/holidays";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { isWeekend } from "@/lib/attendance";
import { formatCalendarDate } from "@/lib/format";
import { ghanaPublicHolidays } from "@/lib/holidays";
import { requireTenant } from "@/web/auth";
import {
  addHolidayAction,
  addSuggestedHolidaysAction,
  createYearAction,
  makeCurrentAction,
  removeHolidayAction,
  updateTermAction,
} from "./actions";
import { AddHolidayDialog, RemoveHolidayButton, SuggestHolidaysDialog } from "./holiday-controls";
import { AddYearDialog, TermActions } from "./calendar-controls";

export const metadata: Metadata = { title: "Settings · Calendar" };

export default async function CalendarPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "academics.manage")) notFound();
  const [years, holidays] = await Promise.all([listAcademicYears(db(), ctx), listHolidays(db(), ctx)]);
  const slug = ctx.tenant.slug;
  const hasCurrent = years.some((y) => y.terms.some((t) => t.isCurrent));
  const add = (
    <AddYearDialog action={createYearAction.bind(null, slug)} suggestedName={suggestedYear().name} />
  );

  const covered = (date: string) => holidays.some((h) => h.startsOn <= date && h.endsOn >= date);
  const range = (h: { startsOn: string; endsOn: string }) =>
    h.startsOn === h.endsOn
      ? formatCalendarDate(h.startsOn)
      : `${formatCalendarDate(h.startsOn)} – ${formatCalendarDate(h.endsOn)}`;

  return (
    <div className="space-y-12">
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

      {years.length > 0 && (
        <Section
          title="School holidays"
          description="Days the school is closed during a term. No register is taken on them, and attendance counts leave them out."
          aside={
            <div className="flex flex-wrap justify-end gap-1">
              {years.slice(0, 2).map((y) => (
                <SuggestHolidaysDialog
                  key={y.id}
                  yearName={y.name}
                  action={addSuggestedHolidaysAction.bind(null, slug)}
                  suggestions={ghanaPublicHolidays(y.startsOn, y.endsOn).map((h) => ({
                    ...h,
                    label: formatCalendarDate(h.date),
                    weekend: isWeekend(h.date),
                    added: covered(h.date),
                  }))}
                />
              ))}
              <AddHolidayDialog action={addHolidayAction.bind(null, slug)} />
            </div>
          }
        >
          {holidays.length === 0 ? (
            <p className="text-base text-ink-3">No holidays added yet.</p>
          ) : (
            <TableFrame>
              <Table>
                <caption className="sr-only">School holidays</caption>
                <THead>
                  <tr>
                    <TH>Holiday</TH>
                    <TH>Dates</TH>
                    <TH>
                      <span className="sr-only">Actions</span>
                    </TH>
                  </tr>
                </THead>
                <TBody>
                  {holidays.map((h) => (
                    <TR key={h.id}>
                      <TD className="font-medium text-ink">{h.name}</TD>
                      <TD className="whitespace-nowrap">{range(h)}</TD>
                      <TD className="text-right">
                        <RemoveHolidayButton
                          name={h.name}
                          action={removeHolidayAction.bind(null, slug, h.id)}
                        />
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
        </Section>
      )}
    </div>
  );
}
