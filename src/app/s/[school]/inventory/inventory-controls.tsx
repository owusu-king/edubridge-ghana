"use client";

import { useActionState } from "react";
import { FormError } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import {
  ASSET_CONDITIONS,
  CONDITION_LABELS,
  MAINTENANCE_NEXT,
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_STATUS_LABELS,
  PRIORITY_LABELS,
  type AssetCondition,
  type MaintenanceStatus,
  type MovementKind,
} from "@/lib/inventory";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
type Option = { id: string; name: string };

const err = (s: FormState) => s.fieldErrors ?? {};
const val = (s: FormState) => s.values ?? {};

/** Adding or changing a stock item (INV-01a). */
export function StockItemDialog({
  action,
  item,
}: {
  action: Action;
  item?: { name: string; category: string | null; unit: string; reorderLevel: number | null };
}) {
  return (
    <FormDialog
      trigger={item ? "Edit item" : "Add an item"}
      triggerVariant={item ? "secondary" : "primary"}
      title={item ? "Edit item" : "Add a stock item"}
      description={item ? undefined : "Then record what you have: Receive adds to stock."}
      submitLabel="Save"
      action={action}
    >
      {(state) => {
        const e = err(state);
        const v = val(state);
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Name" error={e.name} className="sm:col-span-2">
              {(p) => (
                <Input
                  {...p}
                  name="name"
                  maxLength={80}
                  placeholder="e.g. A4 paper"
                  defaultValue={v.name ?? item?.name}
                  required
                />
              )}
            </Field>
            <Field label="Unit" description="What one of it is: ream, box, bag." error={e.unit}>
              {(p) => (
                <Input {...p} name="unit" maxLength={30} defaultValue={v.unit ?? item?.unit} required />
              )}
            </Field>
            <Field label="Category" optional error={e.category}>
              {(p) => (
                <Input
                  {...p}
                  name="category"
                  maxLength={60}
                  placeholder="e.g. Stationery"
                  defaultValue={v.category ?? item?.category ?? ""}
                />
              )}
            </Field>
            <Field
              label="Reorder level"
              optional
              description="Listed as low at or below this."
              error={e.reorderLevel}
            >
              {(p) => (
                <Input
                  {...p}
                  name="reorderLevel"
                  inputMode="numeric"
                  defaultValue={
                    v.reorderLevel ??
                    (item?.reorderLevel === null || item === undefined ? "" : String(item.reorderLevel))
                  }
                />
              )}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

const MOVEMENT_COPY: Record<
  MovementKind,
  { trigger: string; title: string; submit: string; quantity: string }
> = {
  received: {
    trigger: "Receive",
    title: "Receive stock",
    submit: "Add to stock",
    quantity: "How many arrived",
  },
  issued: { trigger: "Issue", title: "Issue stock", submit: "Issue", quantity: "How many" },
  counted: {
    trigger: "Correct count",
    title: "Correct the count",
    submit: "Save count",
    quantity: "How many are on the shelf",
  },
};

/** Receiving, issuing or correcting the count of one item (INV-01a, INV-01b). */
export function MovementDialog({
  action,
  kind,
  unit,
  onHand,
  suppliers,
  currency,
}: {
  action: Action;
  kind: MovementKind;
  unit: string;
  onHand: number;
  suppliers: Option[];
  currency: string;
}) {
  const copy = MOVEMENT_COPY[kind];
  return (
    <FormDialog
      trigger={copy.trigger}
      triggerVariant={kind === "received" ? "primary" : "secondary"}
      title={copy.title}
      description={`${onHand} ${unit} on hand. Every movement is kept as recorded.`}
      submitLabel={copy.submit}
      action={action}
    >
      {(state) => {
        const e = err(state);
        const v = val(state);
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <input type="hidden" name="kind" value={kind} />
            <Field label={`${copy.quantity} (${unit})`} error={e.quantity}>
              {(p) => <Input {...p} name="quantity" inputMode="numeric" defaultValue={v.quantity} required />}
            </Field>
            {kind === "received" && (
              <>
                <Field label={`Unit cost (${currency})`} optional error={e.unitCost}>
                  {(p) => <Input {...p} name="unitCost" inputMode="decimal" defaultValue={v.unitCost} />}
                </Field>
                <Field label="Supplier" optional error={e.supplierId} className="sm:col-span-2">
                  {(p) => (
                    <Select {...p} name="supplierId" defaultValue={v.supplierId ?? ""}>
                      <option value="">Not recorded</option>
                      {suppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </>
            )}
            {kind === "issued" && (
              <Field label="To whom or where" error={e.issuedTo}>
                {(p) => (
                  <Input
                    {...p}
                    name="issuedTo"
                    maxLength={120}
                    placeholder="e.g. Basic 4A"
                    defaultValue={v.issuedTo}
                    required
                  />
                )}
              </Field>
            )}
            <Field
              label={kind === "counted" ? "Why it differs" : "Note"}
              optional={kind !== "counted"}
              error={e.reason}
              className="sm:col-span-2"
            >
              {(p) => (
                <Input
                  {...p}
                  name="reason"
                  maxLength={300}
                  defaultValue={v.reason}
                  required={kind === "counted"}
                />
              )}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

/** Adding or changing a supplier (INV-02a). */
export function SupplierDialog({
  action,
  supplier,
}: {
  action: Action;
  supplier?: {
    name: string;
    contactName: string | null;
    phone: string;
    email: string | null;
    note: string | null;
  };
}) {
  return (
    <FormDialog
      trigger={supplier ? "Edit" : "Add a supplier"}
      triggerVariant={supplier ? "secondary" : "primary"}
      triggerSize={supplier ? "sm" : "md"}
      triggerLabel={supplier ? `Edit ${supplier.name}` : undefined}
      title={supplier ? `Edit ${supplier.name}` : "Add a supplier"}
      submitLabel="Save"
      action={action}
    >
      {(state) => {
        const e = err(state);
        const v = val(state);
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Name" error={e.name} className="sm:col-span-2">
              {(p) => (
                <Input {...p} name="name" maxLength={120} defaultValue={v.name ?? supplier?.name} required />
              )}
            </Field>
            <Field label="Contact person" optional error={e.contactName}>
              {(p) => (
                <Input
                  {...p}
                  name="contactName"
                  maxLength={120}
                  defaultValue={v.contactName ?? supplier?.contactName ?? ""}
                />
              )}
            </Field>
            <Field label="Phone" optional error={e.phone}>
              {(p) => (
                <Input
                  {...p}
                  name="phone"
                  type="tel"
                  inputMode="tel"
                  defaultValue={v.phone ?? supplier?.phone ?? ""}
                />
              )}
            </Field>
            <Field label="Email" optional error={e.email}>
              {(p) => (
                <Input {...p} name="email" type="email" defaultValue={v.email ?? supplier?.email ?? ""} />
              )}
            </Field>
            <Field label="Note" optional error={e.note}>
              {(p) => (
                <Input {...p} name="note" maxLength={300} defaultValue={v.note ?? supplier?.note ?? ""} />
              )}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

function CustodianFields({
  state,
  custodians,
  current,
}: {
  state: FormState;
  custodians: Option[];
  current?: { membershipId: string | null; name: string | null };
}) {
  const e = err(state);
  const v = val(state);
  return (
    <>
      <Field label="Custodian" optional error={e.custodianMembershipId}>
        {(p) => (
          <Select
            {...p}
            name="custodianMembershipId"
            defaultValue={v.custodianMembershipId ?? current?.membershipId ?? ""}
          >
            <option value="">Nobody, or written below</option>
            {custodians.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Or someone without an account" optional error={e.custodianName}>
        {(p) => (
          <Input
            {...p}
            name="custodianName"
            maxLength={120}
            defaultValue={v.custodianName ?? current?.name ?? ""}
          />
        )}
      </Field>
    </>
  );
}

function ConditionField({ state, current }: { state: FormState; current?: AssetCondition }) {
  return (
    <Field label="Condition" error={err(state).condition}>
      {(p) => (
        <Select {...p} name="condition" defaultValue={val(state).condition ?? current ?? "good"}>
          {ASSET_CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {CONDITION_LABELS[c]}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function PurchaseFields({
  state,
  suppliers,
  currency,
  current,
}: {
  state: FormState;
  suppliers: Option[];
  currency: string;
  current?: { acquiredOn: string | null; cost: string; supplierId: string | null };
}) {
  const e = err(state);
  const v = val(state);
  return (
    <>
      <Field label="Acquired on" optional error={e.acquiredOn}>
        {(p) => (
          <Input
            {...p}
            name="acquiredOn"
            type="date"
            defaultValue={v.acquiredOn ?? current?.acquiredOn ?? ""}
          />
        )}
      </Field>
      <Field label={`Cost (${currency})`} optional error={e.cost}>
        {(p) => <Input {...p} name="cost" inputMode="decimal" defaultValue={v.cost ?? current?.cost ?? ""} />}
      </Field>
      <Field label="Supplier" optional error={e.supplierId}>
        {(p) => (
          <Select {...p} name="supplierId" defaultValue={v.supplierId ?? current?.supplierId ?? ""}>
            <option value="">Not recorded</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </>
  );
}

/** Adding an asset to the register (INV-01c); it gets the next tag. */
export function AssetDialog({
  action,
  suppliers,
  custodians,
  currency,
}: {
  action: Action;
  suppliers: Option[];
  custodians: Option[];
  currency: string;
}) {
  return (
    <FormDialog
      trigger="Add an asset"
      triggerVariant="primary"
      title="Add an asset"
      description="It gets the next tag (A0001, A0002, …). Write the tag on it."
      submitLabel="Add"
      size="lg"
      action={action}
    >
      {(state) => {
        const e = err(state);
        const v = val(state);
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Name" error={e.name}>
              {(p) => (
                <Input
                  {...p}
                  name="name"
                  maxLength={120}
                  placeholder="e.g. Epson projector"
                  defaultValue={v.name}
                  required
                />
              )}
            </Field>
            <Field label="Category" optional error={e.category}>
              {(p) => (
                <Input
                  {...p}
                  name="category"
                  maxLength={60}
                  placeholder="e.g. ICT"
                  defaultValue={v.category}
                />
              )}
            </Field>
            <Field label="Serial number" optional error={e.serialNumber}>
              {(p) => <Input {...p} name="serialNumber" maxLength={80} defaultValue={v.serialNumber} />}
            </Field>
            <Field label="Location" optional error={e.location}>
              {(p) => (
                <Input
                  {...p}
                  name="location"
                  maxLength={120}
                  placeholder="e.g. ICT lab"
                  defaultValue={v.location}
                />
              )}
            </Field>
            <CustodianFields state={state} custodians={custodians} />
            <ConditionField state={state} />
            <PurchaseFields state={state} suppliers={suppliers} currency={currency} />
            <Field label="Note" optional error={e.note} className="sm:col-span-2">
              {(p) => <Input {...p} name="note" maxLength={300} defaultValue={v.note} />}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

/** Correcting an asset's description, cost and supplier. */
export function AssetDetailsDialog({
  action,
  asset,
  suppliers,
  currency,
}: {
  action: Action;
  asset: {
    name: string;
    category: string | null;
    serialNumber: string | null;
    note: string | null;
    acquiredOn: string | null;
    cost: string;
    supplierId: string | null;
  };
  suppliers: Option[];
  currency: string;
}) {
  return (
    <FormDialog trigger="Edit details" title="Edit details" submitLabel="Save" size="lg" action={action}>
      {(state) => {
        const e = err(state);
        const v = val(state);
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Name" error={e.name}>
              {(p) => (
                <Input {...p} name="name" maxLength={120} defaultValue={v.name ?? asset.name} required />
              )}
            </Field>
            <Field label="Category" optional error={e.category}>
              {(p) => (
                <Input
                  {...p}
                  name="category"
                  maxLength={60}
                  defaultValue={v.category ?? asset.category ?? ""}
                />
              )}
            </Field>
            <Field label="Serial number" optional error={e.serialNumber}>
              {(p) => (
                <Input
                  {...p}
                  name="serialNumber"
                  maxLength={80}
                  defaultValue={v.serialNumber ?? asset.serialNumber ?? ""}
                />
              )}
            </Field>
            <PurchaseFields state={state} suppliers={suppliers} currency={currency} current={asset} />
            <Field label="Note" optional error={e.note} className="sm:col-span-2">
              {(p) => <Input {...p} name="note" maxLength={300} defaultValue={v.note ?? asset.note ?? ""} />}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

/** Moving an asset, handing it over, or recording its condition: kept as its history. */
export function ChangeAssetDialog({
  action,
  asset,
  custodians,
}: {
  action: Action;
  asset: {
    location: string | null;
    custodianMembershipId: string | null;
    custodianName: string | null;
    condition: AssetCondition;
  };
  custodians: Option[];
}) {
  return (
    <FormDialog
      trigger="Move or hand over"
      triggerVariant="primary"
      title="Move, hand over or record condition"
      description="Change what is different; each change is added to its history."
      submitLabel="Save"
      action={action}
    >
      {(state) => {
        const e = err(state);
        const v = val(state);
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Location" optional error={e.location}>
              {(p) => (
                <Input
                  {...p}
                  name="location"
                  maxLength={120}
                  defaultValue={v.location ?? asset.location ?? ""}
                />
              )}
            </Field>
            <ConditionField state={state} current={asset.condition} />
            <CustodianFields
              state={state}
              custodians={custodians}
              current={{ membershipId: asset.custodianMembershipId, name: asset.custodianName }}
            />
            <Field label="Note" optional error={e.note} className="sm:col-span-2">
              {(p) => <Input {...p} name="note" maxLength={300} defaultValue={v.note} />}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

/** One question with a written answer: disposing, declining, cancelling. */
export function NoteDialog({
  action,
  trigger,
  title,
  description,
  label,
  name,
  required,
  submitLabel,
  danger = false,
  triggerVariant = "secondary",
}: {
  action: Action;
  trigger: string;
  title: string;
  description?: string;
  label: string;
  name: string;
  required: boolean;
  submitLabel: string;
  danger?: boolean;
  triggerVariant?: "primary" | "secondary" | "danger";
}) {
  return (
    <FormDialog
      trigger={trigger}
      triggerVariant={triggerVariant}
      title={title}
      description={description}
      submitLabel={submitLabel}
      danger={danger}
      action={action}
    >
      {(state) => (
        <Field label={label} optional={!required} error={err(state)[name]}>
          {(p) => (
            <Textarea
              {...p}
              name={name}
              rows={3}
              maxLength={500}
              defaultValue={val(state)[name]}
              required={required}
            />
          )}
        </Field>
      )}
    </FormDialog>
  );
}

const LINE_ROWS = 5;

/** A purchase request (INV-02b): what for, and up to five lines. */
export function PurchaseDialog({
  action,
  suppliers,
  stockItems,
  currency,
}: {
  action: Action;
  suppliers: Option[];
  stockItems: Option[];
  currency: string;
}) {
  return (
    <FormDialog
      trigger="Request a purchase"
      triggerVariant="primary"
      title="Request a purchase"
      description="The Proprietor approves or declines it. Leave unused lines empty."
      submitLabel="Send for approval"
      size="lg"
      action={action}
    >
      {(state) => {
        const e = err(state);
        const v = val(state);
        return (
          <div className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="What it is for" error={e.title}>
                {(p) => (
                  <Input
                    {...p}
                    name="title"
                    maxLength={120}
                    placeholder="e.g. Paper for end-of-term exams"
                    defaultValue={v.title}
                    required
                  />
                )}
              </Field>
              <Field label="Supplier" optional error={e.supplierId}>
                {(p) => (
                  <Select {...p} name="supplierId" defaultValue={v.supplierId ?? ""}>
                    <option value="">Not chosen</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <fieldset className="space-y-3">
              <legend className="mb-1 text-sm font-medium text-ink">What to buy</legend>
              {Array.from({ length: LINE_ROWS }, (_, i) => (
                <div key={i} className="grid gap-3 sm:grid-cols-[1fr_6rem_8rem_10rem]">
                  <Field label={`Item ${i + 1}`} error={e[`description_${i}`]}>
                    {(p) => (
                      <Input
                        {...p}
                        name={`description_${i}`}
                        maxLength={200}
                        defaultValue={v[`description_${i}`]}
                      />
                    )}
                  </Field>
                  <Field label="Quantity" error={e[`quantity_${i}`]}>
                    {(p) => (
                      <Input
                        {...p}
                        name={`quantity_${i}`}
                        inputMode="numeric"
                        defaultValue={v[`quantity_${i}`]}
                      />
                    )}
                  </Field>
                  <Field label={`Unit price (${currency})`} error={e[`price_${i}`]}>
                    {(p) => (
                      <Input {...p} name={`price_${i}`} inputMode="decimal" defaultValue={v[`price_${i}`]} />
                    )}
                  </Field>
                  <Field label="Stock item" error={e[`stockItemId_${i}`]}>
                    {(p) => (
                      <Select {...p} name={`stockItemId_${i}`} defaultValue={v[`stockItemId_${i}`] ?? ""}>
                        <option value="">Not stock</option>
                        {stockItems.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                </div>
              ))}
            </fieldset>
            <Field label="Why it is needed" optional error={e.reason}>
              {(p) => <Textarea {...p} name="reason" rows={2} maxLength={1000} defaultValue={v.reason} />}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

/** Recording what arrived for an approved request, line by line (INV-02b). */
export function ReceiveForm({
  action,
  lines,
}: {
  action: Action;
  lines: { id: string; description: string; quantity: number; stockItem: string | null }[];
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const e = err(state);
  return (
    <form action={formAction} className="max-w-2xl space-y-4" noValidate>
      <FormError state={state} />
      {lines.map((l) => (
        <Field
          key={l.id}
          label={`${l.description}: how many arrived`}
          description={l.stockItem ? `Added to stock as ${l.stockItem}.` : `${l.quantity} asked for.`}
          error={e[`received_${l.id}`]}
          className="max-w-md"
        >
          {(p) => (
            <Input
              {...p}
              name={`received_${l.id}`}
              inputMode="numeric"
              defaultValue={state.values?.[`received_${l.id}`] ?? String(l.quantity)}
            />
          )}
        </Field>
      ))}
      <Field label="Note" optional error={e.note} className="max-w-md">
        {(p) => <Input {...p} name="note" maxLength={500} defaultValue={state.values?.note} />}
      </Field>
      <Button type="submit" variant="primary" pending={pending}>
        Record what arrived
      </Button>
    </form>
  );
}

/** Reporting something that needs fixing (INV-02c), for any member of staff. */
export function MaintenanceDialog({
  action,
  assets,
}: {
  action: Action;
  assets: { id: string; label: string }[];
}) {
  return (
    <FormDialog
      trigger="Report something"
      triggerVariant="primary"
      title="Report something that needs fixing"
      submitLabel="Report"
      action={action}
    >
      {(state) => {
        const e = err(state);
        const v = val(state);
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="What needs fixing" error={e.title} className="sm:col-span-2">
              {(p) => (
                <Input
                  {...p}
                  name="title"
                  maxLength={120}
                  placeholder="e.g. Ceiling fan not working"
                  defaultValue={v.title}
                  required
                />
              )}
            </Field>
            <Field label="Where" optional error={e.location}>
              {(p) => (
                <Input
                  {...p}
                  name="location"
                  maxLength={120}
                  placeholder="e.g. Basic 4A"
                  defaultValue={v.location}
                />
              )}
            </Field>
            <Field label="How urgent" error={e.priority}>
              {(p) => (
                <Select {...p} name="priority" defaultValue={v.priority ?? "normal"}>
                  {MAINTENANCE_PRIORITIES.map((x) => (
                    <option key={x} value={x}>
                      {PRIORITY_LABELS[x]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {assets.length > 0 && (
              <Field label="Asset" optional error={e.assetId} className="sm:col-span-2">
                {(p) => (
                  <Select {...p} name="assetId" defaultValue={v.assetId ?? ""}>
                    <option value="">Not an asset in the register</option>
                    {assets.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <Field label="Details" optional error={e.description} className="sm:col-span-2">
              {(p) => (
                <Textarea {...p} name="description" rows={3} maxLength={2000} defaultValue={v.description} />
              )}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

/** The office moves a maintenance request on (INV-02c). */
export function MaintenanceUpdateDialog({
  action,
  status,
  assignedTo,
}: {
  action: Action;
  status: MaintenanceStatus;
  assignedTo: string | null;
}) {
  const choices: MaintenanceStatus[] = [status, ...MAINTENANCE_NEXT[status]];
  return (
    <FormDialog
      trigger="Update"
      triggerVariant="primary"
      title="Update this request"
      submitLabel="Save"
      action={action}
    >
      {(state) => {
        const e = err(state);
        const v = val(state);
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Status" error={e.status}>
              {(p) => (
                <Select {...p} name="status" defaultValue={v.status ?? status}>
                  {choices.map((s) => (
                    <option key={s} value={s}>
                      {MAINTENANCE_STATUS_LABELS[s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="With" optional description="Who is fixing it." error={e.assignedTo}>
              {(p) => (
                <Input
                  {...p}
                  name="assignedTo"
                  maxLength={120}
                  defaultValue={v.assignedTo ?? assignedTo ?? ""}
                />
              )}
            </Field>
            <Field
              label="Note"
              optional
              description="Needed when done: what was done."
              error={e.note}
              className="sm:col-span-2"
            >
              {(p) => <Textarea {...p} name="note" rows={3} maxLength={1000} defaultValue={v.note} />}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}
