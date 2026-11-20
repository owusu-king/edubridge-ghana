"use client";

import { useActionState, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { besideField, Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { FormMessage, SuccessToast } from "@/components/ui/toast";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatCalendarDate } from "@/lib/format";
import { currencySymbol, moneyFormatter } from "@/lib/money";
import {
  ACCOUNT_KIND_LABELS,
  ACCOUNT_KINDS,
  EXPENSE_CATEGORIES,
  EXPENSE_METHOD_LABELS,
  EXPENSE_METHODS,
  UNBANKED_DAYS,
} from "@/lib/school-finance";
import type { FormState } from "@/web/forms";

export { ActionButton } from "@/components/ui/action-forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
type Option = { value: string; label: string };

/** Adding a bank account, cash box or wallet, or changing one's details. */
export function AccountDialog({
  action,
  account,
}: {
  action: Action;
  account?: { name: string; kind: string; institution: string | null; accountEnding: string | null };
}) {
  return (
    <FormDialog
      trigger={account ? "Edit" : "Add an account"}
      triggerVariant={account ? "secondary" : "primary"}
      triggerSize={account ? "sm" : "md"}
      triggerLabel={account ? `Edit ${account.name}` : undefined}
      title={account ? `Edit ${account.name}` : "Add an account"}
      description="Where the school keeps money. For a bank account, record only the last digits of its number."
      submitLabel="Save"
      action={action}
    >
      {(state) => (
        <div className="space-y-5">
          <Field label="Name" error={state.fieldErrors?.name}>
            {(p) => (
              <Input
                {...p}
                name="name"
                placeholder="GCB current account"
                defaultValue={state.values?.name ?? account?.name}
                required
              />
            )}
          </Field>
          {account ? (
            <input type="hidden" name="kind" value={account.kind} />
          ) : (
            <Field label="Kind" error={state.fieldErrors?.kind}>
              {(p) => (
                <Select {...p} name="kind" defaultValue={state.values?.kind ?? "bank"}>
                  {ACCOUNT_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {ACCOUNT_KIND_LABELS[k]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field label="Bank or network" optional error={state.fieldErrors?.institution}>
            {(p) => (
              <Input
                {...p}
                name="institution"
                defaultValue={state.values?.institution ?? account?.institution ?? ""}
              />
            )}
          </Field>
          <Field
            label="Last digits of the account number"
            optional
            description="2 to 6 digits, to tell accounts apart."
            error={state.fieldErrors?.accountEnding}
          >
            {(p) => (
              <Input
                {...p}
                name="accountEnding"
                inputMode="numeric"
                maxLength={6}
                defaultValue={state.values?.accountEnding ?? account?.accountEnding ?? ""}
              />
            )}
          </Field>
        </div>
      )}
    </FormDialog>
  );
}

/** Recording money the school spent. */
export function ExpenseDialog({
  action,
  currency,
  accounts,
  today,
  approvalNote,
}: {
  action: Action;
  currency: string;
  accounts: Option[];
  today: string;
  /** Explains when an expense waits for the Proprietor. */
  approvalNote: string;
}) {
  return (
    <FormDialog
      trigger="Record an expense"
      triggerVariant="primary"
      title="Record an expense"
      description={approvalNote}
      submitLabel="Record expense"
      size="lg"
      action={action}
    >
      {(state) => (
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Date" error={state.fieldErrors?.spentOn}>
            {(p) => (
              <Input
                {...p}
                type="date"
                name="spentOn"
                max={today}
                defaultValue={state.values?.spentOn ?? today}
                required
              />
            )}
          </Field>
          <Field label={`Amount (${currencySymbol(currency)})`} error={state.fieldErrors?.amount}>
            {(p) => (
              <Input
                {...p}
                name="amount"
                inputMode="decimal"
                defaultValue={state.values?.amount}
                className="tabular-nums"
                required
              />
            )}
          </Field>
          <Field label="Category" error={state.fieldErrors?.category}>
            {(p) => (
              <>
                <Input
                  {...p}
                  name="category"
                  list="expense-categories"
                  defaultValue={state.values?.category}
                  required
                />
                <datalist id="expense-categories">
                  {EXPENSE_CATEGORIES.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <Field label="Paid to" error={state.fieldErrors?.payee}>
            {(p) => <Input {...p} name="payee" defaultValue={state.values?.payee} required />}
          </Field>
          <Field label="Paid from" error={state.fieldErrors?.accountId}>
            {(p) => (
              <Select {...p} name="accountId" defaultValue={state.values?.accountId}>
                {accounts.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="How" error={state.fieldErrors?.method}>
            {(p) => (
              <Select {...p} name="method" defaultValue={state.values?.method ?? "cash"}>
                {EXPENSE_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {EXPENSE_METHOD_LABELS[m]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Reference"
            optional
            description="Cheque, transfer or invoice number."
            error={state.fieldErrors?.reference}
          >
            {(p) => <Input {...p} name="reference" maxLength={60} defaultValue={state.values?.reference} />}
          </Field>
          <Field label="What for" optional className="sm:col-span-2" error={state.fieldErrors?.description}>
            {(p) => (
              <Textarea
                {...p}
                name="description"
                rows={2}
                maxLength={500}
                defaultValue={state.values?.description}
              />
            )}
          </Field>
        </div>
      )}
    </FormDialog>
  );
}

/** A reason dialog for voiding or cancelling. */
export function ReasonDialog({
  action,
  trigger,
  title,
  description,
  submitLabel,
  label,
}: {
  action: Action;
  trigger: string;
  title: string;
  description: string;
  submitLabel: string;
  label?: string;
}) {
  return (
    <FormDialog
      trigger={trigger}
      triggerSize="sm"
      triggerLabel={label}
      title={title}
      description={description}
      submitLabel={submitLabel}
      danger
      action={action}
    >
      {(state) => (
        <Field label="Reason" error={state.fieldErrors?.reason}>
          {(p) => (
            <Textarea
              {...p}
              name="reason"
              rows={2}
              maxLength={200}
              defaultValue={state.values?.reason}
              required
            />
          )}
        </Field>
      )}
    </FormDialog>
  );
}

/** The Proprietor approves or rejects an expense (a note is needed to reject). */
export function DecideExpenseDialog({
  action,
  approve,
  label,
}: {
  action: Action;
  approve: boolean;
  label: string;
}) {
  return (
    <FormDialog
      trigger={approve ? "Approve" : "Reject"}
      triggerSize="sm"
      triggerLabel={label}
      title={approve ? "Approve this expense?" : "Reject this expense?"}
      submitLabel={approve ? "Approve" : "Reject"}
      danger={!approve}
      action={action}
    >
      {(state) => (
        <Field label="Note" optional={approve} error={state.fieldErrors?.note}>
          {(p) => (
            <Textarea
              {...p}
              name="note"
              rows={2}
              maxLength={200}
              defaultValue={state.values?.note}
              required={!approve}
            />
          )}
        </Field>
      )}
    </FormDialog>
  );
}

/** The amount from which an expense waits for the Proprietor. */
export function ApprovalAmountForm({
  action,
  currency,
  value,
}: {
  action: Action;
  currency: string;
  value: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="flex flex-wrap items-start gap-3">
      <Field
        label={`Approval needed from (${currencySymbol(currency)})`}
        description="0 means every expense waits for the Proprietor."
        error={state.fieldErrors?.amount}
      >
        {(p) => (
          <Input
            {...p}
            name="amount"
            inputMode="decimal"
            defaultValue={state.values?.amount ?? value}
            className="w-40 tabular-nums"
          />
        )}
      </Field>
      <Button type="submit" variant="secondary" className={besideField} pending={pending}>
        Save
      </Button>
      <FormMessage state={state} />
    </form>
  );
}

export interface DepositableReceipt {
  paymentId: string;
  receiptNumber: string;
  paidOn: string;
  amountPesewas: number;
  method: "cash" | "cheque";
  reference: string | null;
  studentName: string;
  recordedBy: string | null;
  daysHeld: number;
}

/**
 * Choosing the cash and cheque receipts that went to the bank, with the slip's details. The total shown is what the
 * bank slip should say; it is checked against the bank statement when that is imported.
 */
export function DepositForm({
  action,
  currency,
  receipts,
  bankAccounts,
  today,
}: {
  action: Action;
  currency: string;
  receipts: DepositableReceipt[];
  bankAccounts: Option[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [holder, setHolder] = useState("all");
  const show = moneyFormatter(currency);
  const holders = useMemo(
    () => [...new Set(receipts.map((r) => r.recordedBy ?? "System"))].sort(),
    [receipts],
  );
  const visible = receipts.filter((r) => holder === "all" || (r.recordedBy ?? "System") === holder);
  const total = receipts.filter((r) => chosen.has(r.paymentId)).reduce((s, r) => s + r.amountPesewas, 0);
  const toggle = (id: string) =>
    setChosen((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <form action={formAction} className="space-y-5">
      <FormMessage state={state} />
      {holders.length > 1 && (
        <Field label="Recorded by">
          {(p) => (
            <Select {...p} value={holder} onChange={(e) => setHolder(e.target.value)} className="sm:w-64">
              <option value="all">Everyone</option>
              {holders.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <TableFrame>
        <Table>
          <THead>
            <tr>
              <TH>
                <input
                  type="checkbox"
                  aria-label="Choose every receipt shown"
                  className="size-4 accent-ink"
                  checked={visible.length > 0 && visible.every((r) => chosen.has(r.paymentId))}
                  onChange={(e) =>
                    setChosen((set) => {
                      const next = new Set(set);
                      for (const r of visible) {
                        if (e.target.checked) next.add(r.paymentId);
                        else next.delete(r.paymentId);
                      }
                      return next;
                    })
                  }
                />
              </TH>
              <TH>Receipt</TH>
              <TH>Student</TH>
              <TH>Method</TH>
              <TH>Recorded by</TH>
              <TH numeric>Held</TH>
              <TH numeric>Amount</TH>
            </tr>
          </THead>
          <TBody>
            {visible.map((r) => (
              <TR key={r.paymentId}>
                <TD>
                  <input
                    type="checkbox"
                    name="paymentId"
                    value={r.paymentId}
                    aria-label={`Receipt ${r.receiptNumber}`}
                    className="size-4 accent-ink"
                    checked={chosen.has(r.paymentId)}
                    onChange={() => toggle(r.paymentId)}
                  />
                </TD>
                <TD>
                  {r.receiptNumber}
                  <span className="block text-sm text-ink-3">{formatCalendarDate(r.paidOn)}</span>
                </TD>
                <TD>{r.studentName}</TD>
                <TD>{r.method === "cheque" ? `Cheque${r.reference ? ` ${r.reference}` : ""}` : "Cash"}</TD>
                <TD>{r.recordedBy ?? "System"}</TD>
                <TD numeric>
                  <span className={r.daysHeld > UNBANKED_DAYS ? "font-medium text-caution" : undefined}>
                    {r.daysHeld} day{r.daysHeld === 1 ? "" : "s"}
                  </span>
                </TD>
                <TD numeric>{show(r.amountPesewas)}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableFrame>
      <div className="grid gap-5 sm:grid-cols-3">
        <Field label="Bank account" error={state.fieldErrors?.accountId}>
          {(p) => (
            <Select {...p} name="accountId" defaultValue={state.values?.accountId}>
              {bankAccounts.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Date banked" error={state.fieldErrors?.depositedOn}>
          {(p) => (
            <Input
              {...p}
              type="date"
              name="depositedOn"
              max={today}
              defaultValue={state.values?.depositedOn ?? today}
              required
            />
          )}
        </Field>
        <Field label="Bank slip number" optional error={state.fieldErrors?.slipReference}>
          {(p) => (
            <Input {...p} name="slipReference" maxLength={60} defaultValue={state.values?.slipReference} />
          )}
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <p className="text-base text-ink">
          {chosen.size} receipt{chosen.size === 1 ? "" : "s"} chosen ·{" "}
          <span className="font-semibold tabular-nums">{show(total)}</span>
        </p>
        <Button type="submit" pending={pending} disabled={chosen.size === 0}>
          Record deposit
        </Button>
      </div>
    </form>
  );
}

/** Uploading a statement saved as CSV from online banking. */
export function StatementUploadForm({ action }: { action: Action }) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="space-y-2">
      <Field
        label="Bank statement (CSV)"
        description="Save the statement from online banking as CSV. Lines already imported are skipped."
        error={state.fieldErrors?.file ?? (state.status === "error" ? state.message : undefined)}
      >
        {(p) => (
          <div className="flex flex-wrap items-center gap-3">
            <Input
              {...p}
              type="file"
              name="file"
              accept=".csv,text/csv"
              required
              className="min-w-0 grow basis-56 sm:max-w-xs"
            />
            <Button type="submit" variant="secondary" pending={pending}>
              Import
            </Button>
          </div>
        )}
      </Field>
      {state.status === "success" && <p className="text-sm text-ink-2">{state.message}</p>}
      <SuccessToast state={state} />
    </form>
  );
}

/** Explaining a line no record matches (bank charges, interest). */
export function ExplainLineDialog({ action, label }: { action: Action; label: string }) {
  return (
    <FormDialog
      trigger="Explain"
      triggerSize="sm"
      triggerLabel={label}
      title="Explain this line"
      description="For a line no record in EduBridge matches, such as bank charges or interest."
      submitLabel="Save"
      action={action}
    >
      {(state) => (
        <Field label="What it is" error={state.fieldErrors?.note}>
          {(p) => <Input {...p} name="note" maxLength={200} defaultValue={state.values?.note} required />}
        </Field>
      )}
    </FormDialog>
  );
}
