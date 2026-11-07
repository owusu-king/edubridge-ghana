"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { FIRST_CHILD_LABELS, FIRST_CHILD_RULES } from "@/lib/siblings";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

export interface SiblingRuleDefaults {
  firstChild: string;
  secondPercent: string;
  laterPercent: string;
  feeItemId: string;
}

/** The school's sibling discount: who counts as first, and the discount for the second and later children. */
export function SiblingRuleForm({
  action,
  defaults,
  feeItems,
}: {
  action: Action;
  defaults: SiblingRuleDefaults;
  feeItems: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const errors = state.fieldErrors ?? {};
  const v = state.values;
  return (
    <form action={formAction} className="space-y-5" noValidate>
      {state.status !== "idle" && state.message && (
        <Alert tone={state.status === "success" ? "positive" : "critical"}>{state.message}</Alert>
      )}
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Pays in full"
          description="The child who counts as the first."
          error={errors.firstChild}
        >
          {(p) => (
            <Select {...p} name="firstChild" defaultValue={v?.firstChild ?? defaults.firstChild}>
              {FIRST_CHILD_RULES.map((r) => (
                <option key={r} value={r}>
                  {FIRST_CHILD_LABELS[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="On" error={errors.feeItemId}>
          {(p) => (
            <Select {...p} name="feeItemId" defaultValue={v?.feeItemId ?? defaults.feeItemId}>
              <option value="">Every fee item</option>
              {feeItems.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Second child's discount (%)" description="Empty for none." error={errors.secondPercent}>
          {(p) => (
            <Input
              {...p}
              name="secondPercent"
              inputMode="decimal"
              defaultValue={v?.secondPercent ?? defaults.secondPercent}
            />
          )}
        </Field>
        <Field
          label="Third child and later (%)"
          description="Empty to use the second child's discount."
          error={errors.laterPercent}
        >
          {(p) => (
            <Input
              {...p}
              name="laterPercent"
              inputMode="decimal"
              defaultValue={v?.laterPercent ?? defaults.laterPercent}
            />
          )}
        </Field>
      </div>
      <div className="flex justify-end">
        <Button type="submit" variant="secondary" pending={pending}>
          Save rule
        </Button>
      </div>
    </form>
  );
}

export function ApplySiblingDiscounts({
  action,
  added,
  replaced,
  ended,
}: {
  action: Action;
  added: number;
  replaced: number;
  ended: number;
}) {
  return (
    <FormDialog
      trigger="Apply to this term"
      triggerVariant="primary"
      title="Apply the sibling discount rule?"
      description={`${added} ${added === 1 ? "child gets" : "children get"} a sibling discount, ${replaced} ${replaced === 1 ? "has theirs" : "have theirs"} changed and ${ended} ${ended === 1 ? "loses theirs" : "lose theirs"}. Discounts added by hand are not touched. Charges already billed change only when the term is billed again.`}
      submitLabel="Apply rule"
      action={action}
    />
  );
}
