import type { Metadata, Route } from "next";
import Link from "next/link";
import { Scale } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getReconciliation, type ReconciliationDifference } from "@/server/mobile-money/reconciliation";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { reviewDifferenceAction } from "../../finance-actions";
import { ReviewDialog } from "../review-dialog";

export const metadata: Metadata = { title: "Fees · Reconciliation" };

const LABELS: Record<ReconciliationDifference, string> = {
  not_recorded: "Paid, not recorded",
  not_confirmed: "Recorded, not confirmed",
  amount_differs: "Amount differs",
  voided_but_paid: "Voided, but paid",
};

/**
 * Daily reconciliation (PAY-04): each morning yesterday's Mobile Money requests are checked again with the
 * provider. Differences wait here for a person; nothing is corrected automatically.
 */
export default async function ReconciliationPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const { runs, items } = await getReconciliation(db(), ctx);
  const canReview = allowed(ctx, "payments.record");
  const open = items.filter((i) => !i.reviewedAt);
  const tz = ctx.tenant.timezone;

  return (
    <div className="space-y-8">
      <p className="max-w-2xl text-base text-ink-2">
        Every morning after 02:00, the previous day&apos;s Mobile Money prompts are checked again with the
        provider and compared with the receipts EduBridge issued. Anything that does not match is listed here.
        Check the school&apos;s Mobile Money statement, put it right (record the payment, void a receipt or
        refund the family), then mark it reviewed with what you did.
      </p>

      <Section title={open.length ? `To review (${open.length})` : "To review"}>
        {items.length === 0 ? (
          <EmptyState
            icon={<Scale />}
            title="No differences"
            description={
              runs.length
                ? "Every checked payment matched the provider's records."
                : "The first check runs tomorrow morning, after a day with Mobile Money payments."
            }
          />
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Differences found</caption>
              <THead>
                <tr>
                  <TH>Day</TH>
                  <TH>Student</TH>
                  <TH>Difference</TH>
                  <TH className="hidden lg:table-cell">Details</TH>
                  <TH>
                    <span className="sr-only">Review</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {items.map((i) => (
                  <TR key={i.id}>
                    <TD className="whitespace-nowrap">{formatCalendarDate(i.runDate)}</TD>
                    <TD>
                      <Link
                        href={schoolPath(slug, `students/${i.studentId}`) as Route}
                        className="font-medium text-ink hover:underline"
                      >
                        {i.studentName}
                      </Link>
                      <span className="block text-sm text-ink-3">{i.admissionNumber}</span>
                    </TD>
                    <TD>
                      <Badge tone={i.reviewedAt ? "neutral" : "critical"}>{LABELS[i.difference]}</Badge>
                    </TD>
                    <TD className="hidden max-w-md text-sm text-ink-2 lg:table-cell">
                      {i.detail}
                      {i.reviewedAt && (
                        <span className="mt-1 block text-ink-3">
                          Reviewed by {i.reviewedBy ?? "staff"}, {formatDateTime(i.reviewedAt, tz)}:{" "}
                          {i.reviewNote}
                        </span>
                      )}
                    </TD>
                    <TD className="text-right">
                      {!i.reviewedAt && canReview && (
                        <ReviewDialog
                          action={reviewDifferenceAction.bind(null, slug, i.id)}
                          summary={`${LABELS[i.difference]} for ${i.studentName}: ${i.detail}`}
                        />
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>

      <Section title="Daily checks">
        {runs.length === 0 ? (
          <p className="text-base text-ink-3">No checks yet.</p>
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Daily checks</caption>
              <THead>
                <tr>
                  <TH>Day checked</TH>
                  <TH className="text-right">Payments checked</TH>
                  <TH className="text-right">Matched</TH>
                  <TH className="text-right">Differences</TH>
                  <TH className="hidden text-right md:table-cell">Not reachable</TH>
                </tr>
              </THead>
              <TBody>
                {runs.map((r) => (
                  <TR key={r.id}>
                    <TD>{formatCalendarDate(r.runDate)}</TD>
                    <TD className="text-right tabular-nums">{r.checked}</TD>
                    <TD className="text-right tabular-nums">{r.matched}</TD>
                    <TD className="text-right tabular-nums">{r.differences}</TD>
                    <TD className="hidden text-right tabular-nums md:table-cell">{r.errors}</TD>
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
