import { FileDown, MessageCircle } from "lucide-react";
import { buttonStyles } from "@/components/ui/button";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { StudentAccount } from "@/server/fees/ledger";
import { formatCalendarDate } from "@/lib/format";
import { formatCedis, pesewasToInput } from "@/lib/money";
import { cn } from "@/lib/cn";
import Link from "next/link";
import { schoolPath } from "@/lib/routes";
import { formatPercent, type Concession } from "@/server/fees/concessions";
import type { PaymentPlan } from "@/server/fees/payment-plans";
import type { MobileMoneyRequestRow } from "@/server/mobile-money/requests";
import { PaymentPlanView } from "./payment-plan";
import { MobileMoneyRequests } from "./mobile-money";
import { MobileMoneyDialog, type PayerPhone } from "./mobile-money-controls";
import { SmsReminderDialog } from "./reminder-controls";
import {
  addConcessionAction,
  createPaymentPlanAction,
  endConcessionAction,
  recordAdjustmentAction,
  recordPaymentAction,
  requestMobileMoneyAction,
  sendReminderAction,
  reverseEntryAction,
  setOpeningBalanceAction,
} from "./account-actions";
import {
  AdjustmentDialog,
  OpeningBalanceDialog,
  RecordPaymentDialog,
  ReverseEntryDialog,
  AddConcessionDialog,
  EndConcessionButton,
  PaymentPlanDialog,
} from "./account-controls";

function balanceText(pesewas: number): string {
  if (pesewas > 0) return `${formatCedis(pesewas)} owed`;
  if (pesewas < 0) return `${formatCedis(-pesewas)} in credit`;
  return "Nothing owed";
}

/** The student's fee statement: every entry, oldest first, with a running balance. */
export function FeeAccount({
  slug,
  account,
  canManage,
  canRecordPayment,
  payerName,
  today,
  openingAsOf,
  concessions,
  feeItems,
  plan,
  mobileMoney,
  outreach,
}: {
  slug: string;
  account: StudentAccount;
  canManage: boolean;
  canRecordPayment: boolean;
  payerName?: string;
  today: string;
  /** Set when the student has no opening balance yet and the user may add one. */
  openingAsOf?: string;
  concessions: Concession[];
  /** Active fee items, for adding discounts. */
  feeItems: { value: string; label: string }[];
  plan: PaymentPlan | null;
  mobileMoney: {
    /** Whether prompts can be sent (a provider is configured). */
    enabled: boolean;
    testMode: boolean;
    testHint: string | null;
    requests: MobileMoneyRequestRow[];
    phones: PayerPhone[];
    timeZone: string;
  };
  /** Statement download and reminders to the family. */
  outreach: {
    statementHref: string;
    canRemind: boolean;
    /** Set when the family owes and a guardian has a phone number. */
    reminder: {
      contactName: string;
      phone: string;
      remindedToday: boolean;
      lastRemindedOn: string | null;
      smsPreview: string;
      whatsappHref: string;
    } | null;
  };
}) {
  const activeConcessions = concessions.filter((c) => c.status === "active");
  return (
    <Section
      title="Fees"
      aside={
        <p className="text-base font-semibold whitespace-nowrap text-ink tabular-nums">
          {balanceText(account.balancePesewas)}
        </p>
      }
    >
      <div className="space-y-3">
        {canRecordPayment && (
          // Ways to take money: the main actions, spaced so each is an easy target.
          <div className="flex flex-wrap items-center gap-3">
            <RecordPaymentDialog
              action={recordPaymentAction.bind(null, slug, account.student.id)}
              studentName={account.student.name}
              payerName={payerName}
              today={today}
            />
            {mobileMoney.enabled && (
              <MobileMoneyDialog
                action={requestMobileMoneyAction.bind(null, slug, account.student.id)}
                studentName={account.student.name}
                defaultAmount={account.balancePesewas > 0 ? pesewasToInput(account.balancePesewas) : ""}
                phones={mobileMoney.phones}
                testMode={mobileMoney.testMode}
                testHint={mobileMoney.testHint}
              />
            )}
          </div>
        )}
        {canManage && (
          <div className="-ml-3.5 flex flex-wrap gap-x-2 gap-y-1">
            <AdjustmentDialog action={recordAdjustmentAction.bind(null, slug, account.student.id)} />
            {feeItems.length > 0 && (
              <AddConcessionDialog
                action={addConcessionAction.bind(null, slug, account.student.id)}
                items={feeItems}
              />
            )}
            {!plan && account.balancePesewas > 0 && (
              <PaymentPlanDialog
                action={createPaymentPlanAction.bind(null, slug, account.student.id)}
                defaultTotal={pesewasToInput(account.balancePesewas)}
                firstDue={today}
              />
            )}
            {openingAsOf && (
              <OpeningBalanceDialog
                action={setOpeningBalanceAction.bind(null, slug, account.student.id)}
                asOf={openingAsOf}
              />
            )}
          </div>
        )}
        <div className="-ml-3.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <a href={outreach.statementHref} className={buttonStyles("ghost", "sm")}>
            <FileDown aria-hidden="true" />
            Download statement
          </a>
          {outreach.canRemind && outreach.reminder && (
            <>
              {outreach.reminder.remindedToday ? (
                <span className="px-3.5 text-sm text-ink-3">SMS reminder sent today</span>
              ) : (
                <SmsReminderDialog
                  action={sendReminderAction.bind(null, slug, account.student.id)}
                  contactName={outreach.reminder.contactName}
                  phone={outreach.reminder.phone}
                  preview={outreach.reminder.smsPreview}
                />
              )}
              <a
                href={outreach.reminder.whatsappHref}
                target="_blank"
                rel="noopener noreferrer"
                className={buttonStyles("ghost", "sm")}
              >
                <MessageCircle aria-hidden="true" />
                WhatsApp reminder
              </a>
            </>
          )}
        </div>
      </div>
      {plan && (
        <PaymentPlanView slug={slug} studentId={account.student.id} plan={plan} canManage={canManage} />
      )}
      {mobileMoney.requests.length > 0 && (
        <MobileMoneyRequests
          slug={slug}
          studentId={account.student.id}
          requests={mobileMoney.requests}
          timeZone={mobileMoney.timeZone}
          canCheck={canRecordPayment}
        />
      )}
      {activeConcessions.length > 0 && (
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium text-ink">Scholarships and discounts</h3>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {activeConcessions.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="text-base text-ink">
                  {c.label}{" "}
                  <span className="text-ink-3">
                    ·{" "}
                    {c.percentBasisPoints !== null
                      ? formatPercent(c.percentBasisPoints)
                      : formatCedis(c.amountPesewas!)}{" "}
                    off {c.feeItemName ?? "every fee item"}
                  </span>
                </span>
                {canManage && (
                  <EndConcessionButton
                    action={endConcessionAction.bind(null, slug, account.student.id, c.id)}
                    label={c.label}
                  />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {account.entries.length === 0 ? (
        <p className="text-base text-ink-3">No fees billed yet.</p>
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Fee statement for {account.student.name}</caption>
            <THead>
              <tr>
                <TH className="hidden sm:table-cell">Date</TH>
                <TH>Entry</TH>
                <TH className="text-right">Amount</TH>
                <TH className="hidden text-right sm:table-cell">Balance</TH>
                {canManage && (
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                )}
              </tr>
            </THead>
            <TBody>
              {account.entries.map((entry) => (
                <TR key={entry.id}>
                  <TD className="hidden whitespace-nowrap sm:table-cell">
                    {formatCalendarDate(entry.effectiveOn)}
                  </TD>
                  <TD>
                    {entry.paymentId ? (
                      <Link
                        href={schoolPath(slug, `fees/receipts/${entry.paymentId}`)}
                        className={cn("text-accent hover:underline", entry.reversed && "line-through")}
                      >
                        {entry.description}
                      </Link>
                    ) : (
                      <span className={cn("text-ink", entry.reversed && "text-ink-3 line-through")}>
                        {entry.description}
                      </span>
                    )}
                    <span className="block text-sm text-ink-3 sm:hidden">
                      {formatCalendarDate(entry.effectiveOn)}
                    </span>
                    {entry.reversed && <span className="block text-sm text-ink-3">Reversed</span>}
                  </TD>
                  <TD className="text-right whitespace-nowrap tabular-nums">
                    {formatCedis(entry.amountPesewas)}
                  </TD>
                  <TD className="hidden text-right whitespace-nowrap tabular-nums sm:table-cell">
                    {formatCedis(entry.balancePesewas)}
                  </TD>
                  {canManage && (
                    <TD className="text-right">
                      {!entry.reversed && entry.kind !== "reversal" && entry.kind !== "payment" && (
                        <ReverseEntryDialog
                          action={reverseEntryAction.bind(null, slug, account.student.id, entry.id)}
                          description={entry.description}
                          amount={formatCedis(entry.amountPesewas)}
                        />
                      )}
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </Section>
  );
}
