import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/ui/action-forms";
import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listBorrowerOptions, listOpenLoans } from "@/server/library/loans";
import { formatCalendarDate } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { lendAction, lostAction, renewAction, returnAction, returnByNumberAction } from "../actions";
import { DeskForms, ReasonDialog, ReturnButton } from "../library-controls";

export const metadata: Metadata = { title: "Library · Loans" };

/** The desk (lend, return) and every book out now, most overdue first (LIB-01c, LIB-01d). */
export default async function LoansPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "library.view")) notFound();
  const slug = ctx.tenant.slug;
  const manage = allowed(ctx, "library.manage");
  const [loans, borrowers] = await Promise.all([
    listOpenLoans(db(), ctx),
    manage ? listBorrowerOptions(db(), ctx) : Promise.resolve([]),
  ]);
  const overdue = loans.filter((l) => l.daysLate > 0).length;

  return (
    <div className="space-y-10">
      {manage && (
        <Section title="Desk" description="Type or scan the number written in the book.">
          <DeskForms
            lend={lendAction.bind(null, slug)}
            giveBack={returnByNumberAction.bind(null, slug)}
            borrowers={borrowers}
          />
        </Section>
      )}

      <Section
        title="Books out"
        description={
          loans.length ? `${loans.length} out${overdue ? `, ${overdue} overdue` : ""}.` : "Nothing is out."
        }
      >
        {loans.length > 0 && (
          <TableFrame>
            <Table>
              <caption className="sr-only">Books out</caption>
              <THead>
                <tr>
                  <TH>Book</TH>
                  <TH>Borrower</TH>
                  <TH>Due</TH>
                  {manage && (
                    <TH>
                      <span className="sr-only">Return, renew or lost</span>
                    </TH>
                  )}
                </tr>
              </THead>
              <TBody>
                {loans.map((l) => (
                  <TR key={l.id}>
                    <TD>
                      <span className="font-medium text-ink">{l.title}</span>
                      <span className="block text-sm text-ink-3 tabular-nums">{l.copy}</span>
                    </TD>
                    <TD>
                      {l.borrower}
                      <span className="block text-sm text-ink-3">
                        {l.isStudent ? (l.className ?? "Student") : "Staff"}
                      </span>
                    </TD>
                    <TD>
                      {l.daysLate > 0 ? (
                        <StatusText tone="critical">
                          {l.daysLate} {l.daysLate === 1 ? "day" : "days"} late
                        </StatusText>
                      ) : (
                        formatCalendarDate(l.dueOn)
                      )}
                      {l.renewals > 0 && (
                        <span className="block text-sm text-ink-3">
                          Renewed {l.renewals === 1 ? "once" : `${l.renewals} times`}
                        </span>
                      )}
                    </TD>
                    {manage && (
                      <TD className="text-right">
                        <div className="inline-flex flex-wrap items-start justify-end gap-2">
                          <ReturnButton
                            action={returnAction.bind(null, slug, l.id)}
                            label={`Return ${l.copy}`}
                          />
                          {l.daysLate === 0 && (
                            <ActionButton
                              action={renewAction.bind(null, slug, l.id)}
                              label="Renew"
                              ariaLabel={`Renew ${l.copy}`}
                            />
                          )}
                          <ReasonDialog
                            action={lostAction.bind(null, slug, l.id)}
                            trigger="Lost"
                            triggerLabel={`${l.copy} is lost`}
                            title={`${l.copy} is lost`}
                            description="Closes the loan and withdraws the copy. To charge for the book, the Accountant adds a charge to the student's fee account."
                            label="Note"
                            required={false}
                            submitLabel="Mark lost"
                          />
                        </div>
                      </TD>
                    )}
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
