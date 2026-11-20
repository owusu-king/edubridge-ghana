"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { besideField, Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { FormError, SuccessToast } from "@/components/ui/toast";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
export type BorrowerOption = { key: string; name: string; group: string };

const err = (s: FormState) => s.fieldErrors ?? {};
const val = (s: FormState) => s.values ?? {};

function BorrowerSelect({ state, borrowers }: { state: FormState; borrowers: BorrowerOption[] }) {
  const groups = [...new Set(borrowers.map((b) => b.group))];
  return (
    <Field label="Borrower" error={err(state).borrower}>
      {(p) => (
        <Select {...p} name="borrower" defaultValue={val(state).borrower ?? ""} required>
          <option value="" disabled>
            Choose a student or member of staff
          </option>
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {borrowers
                .filter((b) => b.group === g)
                .map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </Select>
      )}
    </Field>
  );
}

/** Adding a book to the catalogue (LIB-01a), with its first copies, or changing one. */
export function TitleDialog({
  action,
  title,
}: {
  action: Action;
  title?: {
    title: string;
    author: string | null;
    isbn: string | null;
    publisher: string | null;
    publishedYear: number | null;
    category: string | null;
  };
}) {
  return (
    <FormDialog
      trigger={title ? "Edit" : "Add a book"}
      triggerVariant={title ? "secondary" : "primary"}
      title={title ? "Edit book" : "Add a book"}
      description={title ? undefined : "Each copy gets a number (B0001, B0002, …): write it in the book."}
      submitLabel="Save"
      size="lg"
      action={action}
    >
      {(state) => {
        const e = err(state);
        const v = val(state);
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Title" error={e.title} className="sm:col-span-2">
              {(p) => (
                <Input {...p} name="title" maxLength={200} defaultValue={v.title ?? title?.title} required />
              )}
            </Field>
            <Field label="Author" optional error={e.author}>
              {(p) => (
                <Input {...p} name="author" maxLength={200} defaultValue={v.author ?? title?.author ?? ""} />
              )}
            </Field>
            <Field label="ISBN" optional error={e.isbn}>
              {(p) => (
                <Input
                  {...p}
                  name="isbn"
                  maxLength={20}
                  inputMode="numeric"
                  defaultValue={v.isbn ?? title?.isbn ?? ""}
                />
              )}
            </Field>
            <Field label="Publisher" optional error={e.publisher}>
              {(p) => (
                <Input
                  {...p}
                  name="publisher"
                  maxLength={120}
                  defaultValue={v.publisher ?? title?.publisher ?? ""}
                />
              )}
            </Field>
            <Field label="Year" optional error={e.publishedYear}>
              {(p) => (
                <Input
                  {...p}
                  name="publishedYear"
                  inputMode="numeric"
                  defaultValue={v.publishedYear ?? (title?.publishedYear ? String(title.publishedYear) : "")}
                />
              )}
            </Field>
            <Field label="Category" optional error={e.category}>
              {(p) => (
                <Input
                  {...p}
                  name="category"
                  maxLength={60}
                  placeholder="e.g. Fiction, Science"
                  defaultValue={v.category ?? title?.category ?? ""}
                />
              )}
            </Field>
            {!title && (
              <>
                <Field label="Copies" error={e.copies}>
                  {(p) => <Input {...p} name="copies" inputMode="numeric" defaultValue={v.copies ?? "1"} />}
                </Field>
                <Field label="Shelf" optional error={e.shelf}>
                  {(p) => <Input {...p} name="shelf" maxLength={60} defaultValue={v.shelf} />}
                </Field>
              </>
            )}
          </div>
        );
      }}
    </FormDialog>
  );
}

export function AddCopiesDialog({ action }: { action: Action }) {
  return (
    <FormDialog trigger="Add copies" title="Add copies" submitLabel="Add" action={action}>
      {(state) => (
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="How many" error={err(state).count}>
            {(p) => (
              <Input
                {...p}
                name="count"
                inputMode="numeric"
                defaultValue={val(state).count ?? "1"}
                required
              />
            )}
          </Field>
          <Field label="Shelf" optional error={err(state).shelf}>
            {(p) => <Input {...p} name="shelf" maxLength={60} defaultValue={val(state).shelf} />}
          </Field>
        </div>
      )}
    </FormDialog>
  );
}

/** One question with a written answer: withdrawing a copy, marking a book lost. */
export function ReasonDialog({
  action,
  trigger,
  triggerLabel,
  title,
  description,
  label,
  required,
  submitLabel,
}: {
  action: Action;
  trigger: string;
  triggerLabel: string;
  title: string;
  description?: string;
  label: string;
  required: boolean;
  submitLabel: string;
}) {
  return (
    <FormDialog
      trigger={trigger}
      triggerSize="sm"
      triggerLabel={triggerLabel}
      title={title}
      description={description}
      submitLabel={submitLabel}
      danger
      action={action}
    >
      {(state) => (
        <Field label={label} optional={!required} error={err(state).reason}>
          {(p) => (
            <Textarea
              {...p}
              name="reason"
              rows={2}
              maxLength={200}
              defaultValue={val(state).reason}
              required={required}
            />
          )}
        </Field>
      )}
    </FormDialog>
  );
}

export function ReserveDialog({ action, borrowers }: { action: Action; borrowers: BorrowerOption[] }) {
  return (
    <FormDialog
      trigger="Reserve"
      title="Reserve this book"
      description="The next copy returned is held for them."
      submitLabel="Add to the queue"
      action={action}
    >
      {(state) => <BorrowerSelect state={state} borrowers={borrowers} />}
    </FormDialog>
  );
}

/**
 * The desk (LIB-01c): lend a copy by its number, or take one back. The outcome stays on screen, because it can say
 * the book was late, a fine was charged, or the copy is now held for someone.
 */
export function DeskForms({
  lend,
  giveBack,
  borrowers,
}: {
  lend: Action;
  giveBack: Action;
  borrowers: BorrowerOption[];
}) {
  const [lent, lendAction, lending] = useActionState(lend, { status: "idle" } as FormState);
  const [back, backAction, returning] = useActionState(giveBack, { status: "idle" } as FormState);
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <form action={lendAction} className="space-y-4" noValidate aria-label="Lend a book">
        <h3 className="text-base font-semibold text-ink">Lend</h3>
        <FormError state={lent} />
        <SuccessToast state={lent} />
        <Field label="Copy number" error={err(lent).copy}>
          {(p) => (
            <Input
              {...p}
              name="copy"
              maxLength={20}
              placeholder="B0012"
              autoComplete="off"
              defaultValue={val(lent).copy}
              required
            />
          )}
        </Field>
        <BorrowerSelect state={lent} borrowers={borrowers} />
        <Button type="submit" variant="primary" pending={lending}>
          Lend
        </Button>
      </form>
      <form action={backAction} className="space-y-4" noValidate aria-label="Return a book">
        <h3 className="text-base font-semibold text-ink">Return</h3>
        <SuccessToast state={back} />
        <FormError state={back} />
        <Field label="Copy number" error={err(back).copy}>
          {(p) => <Input {...p} name="copy" maxLength={20} placeholder="B0012" autoComplete="off" required />}
        </Field>
        <Button type="submit" variant="secondary" pending={returning}>
          Return
        </Button>
      </form>
    </div>
  );
}

/** The outcome of returning from the list of loans, kept on screen (fines, holds). */
export function ReturnButton({
  action,
  label,
}: {
  action: (prev: FormState) => Promise<FormState>;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form action={formAction} className="inline-flex flex-col items-end gap-1">
      <Button type="submit" size="sm" variant="secondary" pending={pending} aria-label={label}>
        Return
      </Button>
      {state.status !== "idle" && (
        <span
          className={
            state.status === "error"
              ? "max-w-xs text-right text-sm text-critical"
              : "max-w-xs text-right text-sm text-positive"
          }
        >
          {state.message}
        </span>
      )}
    </form>
  );
}

export function LoanRulesForm({
  action,
  loanDays,
  maxLoans,
}: {
  action: Action;
  loanDays: number;
  maxLoans: number;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const e = err(state);
  return (
    <form action={formAction} className="flex flex-wrap items-start gap-4" noValidate aria-label="Loan rules">
      <SuccessToast state={state} />
      <Field label="Loan period (days)" error={e.loanDays} className="w-40">
        {(p) => (
          <Input
            {...p}
            name="loanDays"
            inputMode="numeric"
            defaultValue={val(state).loanDays ?? String(loanDays)}
          />
        )}
      </Field>
      <Field label="Books at once" error={e.maxLoans} className="w-40">
        {(p) => (
          <Input
            {...p}
            name="maxLoans"
            inputMode="numeric"
            defaultValue={val(state).maxLoans ?? String(maxLoans)}
          />
        )}
      </Field>
      <Button type="submit" variant="secondary" className={besideField} pending={pending}>
        Save
      </Button>
    </form>
  );
}

export function FineRulesForm({
  action,
  currency,
  enabled,
  perDay,
  cap,
}: {
  action: Action;
  currency: string;
  enabled: boolean;
  perDay: string;
  cap: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const e = err(state);
  const v = val(state);
  return (
    <form action={formAction} className="max-w-2xl space-y-4" noValidate aria-label="Fines">
      <SuccessToast state={state} />
      <FormError state={state} />
      <label className="flex items-start gap-3 text-base text-ink">
        <input
          type="checkbox"
          name="finesEnabled"
          defaultChecked={v.finesEnabled ? v.finesEnabled === "on" : enabled}
          className="mt-1 size-4 accent-accent"
        />
        <span>
          Fine students who return books late
          <span className="block text-sm text-ink-3">
            Added to the student&apos;s fee account when the book comes back. Staff are not fined.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap gap-4">
        <Field label={`Per day late (${currency})`} error={e.finePerDay} className="w-48">
          {(p) => (
            <Input {...p} name="finePerDay" inputMode="decimal" defaultValue={v.finePerDay ?? perDay} />
          )}
        </Field>
        <Field label={`Most for one book (${currency})`} optional error={e.fineCap} className="w-56">
          {(p) => <Input {...p} name="fineCap" inputMode="decimal" defaultValue={v.fineCap ?? cap} />}
        </Field>
      </div>
      <Button type="submit" variant="secondary" pending={pending}>
        Save fines
      </Button>
    </form>
  );
}
