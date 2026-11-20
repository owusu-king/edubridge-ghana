import type { Metadata, Route } from "next";
import Link from "next/link";
import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import {
  ActionButton,
  DecideRefundDialog,
  DiscountApprovalForm,
  PayRefundDialog,
} from "@/components/fees/finance-forms";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { formatPercent, listPendingConcessions } from "@/server/fees/concessions";
import { listRefunds, type RefundRow } from "@/server/fees/refunds";
import { getSchoolPreferences } from "@/server/tenancy/preferences";
import { formatDate, todayIn } from "@/lib/format";
import { minorToInput, moneyFormatter } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import {
  approveConcessionAction,
  cancelRefundAction,
  decideRefundAction,
  payRefundAction,
  saveDiscountApprovalAction,
} from "../finance-actions";

export const metadata: Metadata = { title: "Fees · Refunds and approvals" };

const STATUS: Record<
  RefundRow["status"],
  { label: string; tone: "positive" | "caution" | "critical" | "neutral" }
> = {
  requested: { label: "Waiting for approval", tone: "caution" },
  approved: { label: "Approved: to pay out", tone: "caution" },
  rejected: { label: "Rejected", tone: "critical" },
  paid: { label: "Paid", tone: "positive" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/** Refunds (FIN-10) and discounts waiting for the Proprietor (FIN-05). */
export default async function ApprovalsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const showMoney = moneyFormatter(ctx.tenant.currencyCode);
  const slug = ctx.tenant.slug;
  const [pending, refundRows, prefs] = await Promise.all([
    listPendingConcessions(db(), ctx),
    listRefunds(db(), ctx),
    getSchoolPreferences(db(), ctx),
  ]);
  const canRefund = allowed(ctx, "fees.refund");
  const canApprove = allowed(ctx, "fees.approve_discounts");
  const today = todayIn(ctx.tenant.timezone);
  const student = (id: string, name: string) => (
    <Link href={schoolPath(slug, `students/${id}`) as Route} className="text-accent hover:underline">
      {name}
    </Link>
  );

  return (
    <div className="space-y-12">
      <Section
        title="Refunds"
        description="Refunds of a family's credit are requested from the student's page. When the school has more than one finance user, someone other than the requester approves; then the payout is recorded."
      >
        {refundRows.length === 0 ? (
          <p className="text-base text-ink-2">No refunds yet.</p>
        ) : (
          <TableFrame>
            <Table>
              <THead>
                <tr>
                  <TH>Student</TH>
                  <TH numeric>Amount</TH>
                  <TH>Reason</TH>
                  <TH>Status</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {refundRows.map((r) => (
                  <TR key={r.id}>
                    <TD className="text-ink">
                      {student(r.studentId, r.studentName)}
                      <span className="block text-sm text-ink-3">
                        Requested by {r.requestedBy}, {formatDate(r.requestedAt, ctx.tenant.timezone)}
                      </span>
                    </TD>
                    <TD numeric>{showMoney(r.amountPesewas)}</TD>
                    <TD>{r.reason}</TD>
                    <TD>
                      <StatusText tone={STATUS[r.status].tone}>{STATUS[r.status].label}</StatusText>
                      {r.refundNumber && (
                        <span className="block text-sm text-ink-3">
                          {r.refundNumber}, {r.paidOn}
                        </span>
                      )}
                    </TD>
                    <TD className="text-right">
                      {canRefund && (
                        <div className="flex flex-wrap justify-end gap-2">
                          {r.status === "requested" && (
                            <>
                              <DecideRefundDialog
                                action={decideRefundAction.bind(null, slug, r.id, false)}
                                approve={false}
                                label={`Reject the refund for ${r.studentName}`}
                              />
                              <DecideRefundDialog
                                action={decideRefundAction.bind(null, slug, r.id, true)}
                                approve
                                label={`Approve the refund for ${r.studentName}`}
                              />
                            </>
                          )}
                          {r.status === "approved" && (
                            <PayRefundDialog
                              action={payRefundAction.bind(null, slug, r.id)}
                              today={today}
                              label={`Record the refund paid to ${r.studentName}`}
                            />
                          )}
                          {(r.status === "requested" || r.status === "approved") && (
                            <ActionButton
                              action={cancelRefundAction.bind(null, slug, r.id)}
                              label="Cancel"
                              variant="danger-outline"
                              ariaLabel={`Cancel the refund for ${r.studentName}`}
                            />
                          )}
                        </div>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>

      <Section
        title="Discounts waiting for approval"
        description="Discounts above the school's threshold are not billed until the Proprietor approves them."
      >
        {pending.length === 0 ? (
          <p className="text-base text-ink-2">None waiting.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {pending.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span className="text-base text-ink">
                  {student(c.studentId, c.studentName)}: {c.label},{" "}
                  {c.percentBasisPoints !== null
                    ? formatPercent(c.percentBasisPoints)
                    : showMoney(c.amountPesewas ?? 0)}
                  <span className="block text-sm text-ink-3">Added by {c.requestedBy ?? "someone"}</span>
                </span>
                {canApprove && (
                  <ActionButton
                    action={approveConcessionAction.bind(null, slug, c.id)}
                    label="Approve"
                    ariaLabel={`Approve the discount for ${c.studentName}`}
                    variant="primary"
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {canApprove && (
        <Section
          title="When discounts need approval"
          description="Discounts added by Accountants above these limits wait for you."
        >
          <DiscountApprovalForm
            action={saveDiscountApprovalAction.bind(null, slug)}
            percent={
              prefs.discountApprovalBasisPoints === null
                ? ""
                : String(prefs.discountApprovalBasisPoints / 100)
            }
            amount={
              prefs.discountApprovalPesewas === null
                ? ""
                : minorToInput(prefs.discountApprovalPesewas, ctx.tenant.currencyCode)
            }
          />
        </Section>
      )}
    </div>
  );
}
