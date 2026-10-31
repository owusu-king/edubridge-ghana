"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { Field, Input, Select } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { cn } from "@/lib/cn";
import { formatCedis, parseCedis } from "@/lib/money";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
interface Option {
  value: string;
  label: string;
}

// Field names match the server's `levelAmountField` / `classAmountField`.
const levelField = (itemId: string) => `amount:${itemId}`;
const classField = (classId: string, itemId: string) => `class:${classId}:${itemId}`;

export function SetupFeeItemsDialog({ action, names }: { action: Action; names: readonly string[] }) {
  return (
    <FormDialog
      trigger="Add the usual items"
      triggerVariant="primary"
      title="Add fee items"
      description="Choose what your school charges for. You can rename these or add others afterwards."
      submitLabel="Add items"
      action={action}
    >
      {(state) => (
        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-sm font-medium text-ink">Fee items</legend>
          {names.map((name) => (
            <label key={name} className="flex items-center gap-2.5 text-base text-ink">
              <input type="checkbox" name="names" value={name} defaultChecked className="size-4 accent-ink" />
              {name}
            </label>
          ))}
          {state.fieldErrors?.names && <p className="text-sm text-critical">{state.fieldErrors.names}</p>}
        </fieldset>
      )}
    </FormDialog>
  );
}

export function AddFeeItemDialog({ action, primary = false }: { action: Action; primary?: boolean }) {
  return (
    <FormDialog
      trigger={
        <>
          <Plus aria-hidden="true" />
          Add fee item
        </>
      }
      triggerVariant={primary ? "primary" : "secondary"}
      title="Add fee item"
      submitLabel="Add item"
      action={action}
    >
      {(state) => (
        <Field
          label="Name"
          description="For example Tuition, Transport or Sports levy."
          error={state.fieldErrors?.name}
        >
          {(p) => <Input {...p} name="name" defaultValue={state.values?.name} required maxLength={60} />}
        </Field>
      )}
    </FormDialog>
  );
}

export function RenameFeeItemDialog({ action, name }: { action: Action; name: string }) {
  return (
    <FormDialog
      trigger="Rename"
      triggerVariant="ghost"
      triggerSize="sm"
      triggerLabel={`Rename ${name}`}
      title={`Rename ${name}`}
      submitLabel="Save"
      action={action}
    >
      {(state) => (
        <Field label="Name" error={state.fieldErrors?.name}>
          {(p) => (
            <Input {...p} name="name" defaultValue={state.values?.name ?? name} required maxLength={60} />
          )}
        </Field>
      )}
    </FormDialog>
  );
}

export function FeeItemStatusDialog({
  action,
  name,
  archived,
}: {
  action: Action;
  name: string;
  archived: boolean;
}) {
  return (
    <FormDialog
      trigger={archived ? "Restore" : "Archive"}
      triggerVariant="ghost"
      triggerSize="sm"
      triggerLabel={`${archived ? "Restore" : "Archive"} ${name}`}
      title={archived ? `Restore ${name}?` : `Archive ${name}?`}
      description={
        archived
          ? "The item can be used in fee structures again."
          : "The item is no longer offered for new terms. Amounts already set and anything billed stay as they are."
      }
      submitLabel={archived ? "Restore item" : "Archive item"}
      danger={!archived}
      action={action}
    />
  );
}

export function CopyStructureDialog({ action, terms }: { action: Action; terms: Option[] }) {
  return (
    <FormDialog
      trigger="Copy from another term"
      title="Copy fees from another term"
      description="Every level's amounts are copied. You can then change any level."
      submitLabel="Copy fees"
      action={action}
    >
      {(state) => (
        <Field label="Copy from" error={state.fieldErrors?.fromTermId}>
          {(p) => (
            <Select {...p} name="fromTermId" defaultValue={state.values?.fromTermId ?? terms[0]?.value}>
              {terms.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
    </FormDialog>
  );
}

/** Amounts as typed, keyed by field name. */
type Amounts = Record<string, string>;

function sumTyped(values: (string | undefined)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (!value?.trim()) continue;
    const pesewas = parseCedis(value);
    if (pesewas === null) return null;
    total += pesewas;
  }
  return total;
}

/**
 * Amounts for one level in one term: a column for the whole level and, where the level has several
 * classes, a column per class for any class that pays differently.
 */
export function LevelFeesDialog({
  action,
  levelName,
  termLabel,
  items,
  classes,
  initial,
  hasAmounts,
}: {
  action: Action;
  levelName: string;
  termLabel: string;
  items: Option[];
  classes: Option[];
  initial: Amounts;
  hasAmounts: boolean;
}) {
  return (
    <FormDialog
      trigger={hasAmounts ? "Edit" : "Set fees"}
      triggerVariant={hasAmounts ? "ghost" : "secondary"}
      triggerSize="sm"
      triggerLabel={`${hasAmounts ? "Edit" : "Set"} fees for ${levelName}`}
      title={`${levelName} fees`}
      description={`${termLabel}. Amounts in cedis. Leave an item blank if ${levelName} does not pay it.`}
      submitLabel="Save fees"
      size={classes.length > 1 ? "lg" : "md"}
      action={action}
    >
      {(state) => <AmountGrid state={state} items={items} classes={classes} initial={initial} />}
    </FormDialog>
  );
}

function AmountGrid({
  state,
  items,
  classes,
  initial,
}: {
  state: FormState;
  items: Option[];
  classes: Option[];
  initial: Amounts;
}) {
  const [amounts, setAmounts] = useState<Amounts>(() => ({ ...initial, ...state.values }));
  // Class columns appear only when a level has more than one class; one class always pays the level's fees.
  const classColumns = classes.length > 1 ? classes : [];
  const errors = Object.entries(state.fieldErrors ?? {});
  const input = (name: string, label: string, placeholder?: string) => (
    <Input
      name={name}
      aria-label={label}
      aria-invalid={state.fieldErrors?.[name] ? true : undefined}
      inputMode="decimal"
      autoComplete="off"
      placeholder={placeholder}
      value={amounts[name] ?? ""}
      onChange={(e) => setAmounts((prev) => ({ ...prev, [name]: e.target.value }))}
      className="h-9 min-w-24 text-right tabular-nums"
    />
  );
  const levelTotal = sumTyped(items.map((i) => amounts[levelField(i.value)]));
  const classTotal = (classId: string) =>
    sumTyped(items.map((i) => amounts[classField(classId, i.value)]?.trim() || amounts[levelField(i.value)]));
  const total = (value: number | null) => (value === null ? "Check amounts" : formatCedis(value));

  return (
    <div className="space-y-3">
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full border-separate border-spacing-x-2 border-spacing-y-1.5 text-base">
          <thead>
            <tr className="text-left text-sm text-ink-3">
              <th scope="col" className="font-medium">
                Item
              </th>
              <th scope="col" className="text-right font-medium">
                {classColumns.length ? "Whole level" : "Amount"}
              </th>
              {classColumns.map((c) => (
                <th key={c.value} scope="col" className="text-right font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.value}>
                <th scope="row" className="pr-2 text-left font-normal whitespace-nowrap text-ink">
                  {item.label}
                </th>
                <td>{input(levelField(item.value), `${item.label}, whole level`)}</td>
                {classColumns.map((c) => (
                  <td key={c.value}>
                    {input(classField(c.value, item.value), `${item.label}, ${c.label}`, "Same")}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="text-ink">
              <th scope="row" className="pt-2 text-left font-semibold">
                Total per term
              </th>
              <td
                className={cn(
                  "pt-2 text-right font-semibold tabular-nums",
                  levelTotal === null && "text-critical",
                )}
              >
                {total(levelTotal)}
              </td>
              {classColumns.map((c) => {
                const value = classTotal(c.value);
                return (
                  <td
                    key={c.value}
                    className={cn(
                      "pt-2 text-right font-semibold tabular-nums",
                      value === null && "text-critical",
                    )}
                  >
                    {total(value)}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
      {classColumns.length > 0 && (
        <p className="text-sm text-ink-3">
          Leave a class blank to charge the level&rsquo;s amount. Enter 0 to exempt a class from an item.
        </p>
      )}
      {errors.length > 0 && (
        <p role="alert" className="text-sm text-critical">
          {errors[0]![1]}
        </p>
      )}
    </div>
  );
}
