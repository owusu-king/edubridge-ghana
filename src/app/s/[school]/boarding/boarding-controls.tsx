"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { SuccessToast } from "@/components/ui/toast";
import { HOUSE_KINDS, HOUSE_KIND_LABELS, type HouseKind } from "@/lib/boarding";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;
const err = (s: FormState) => s.fieldErrors ?? {};
const val = (s: FormState) => s.values ?? {};

/** Adding a house, or renaming it (BRD-01a). */
export function HouseDialog({
  action,
  house,
}: {
  action: Action;
  house?: { name: string; kind: HouseKind };
}) {
  return (
    <FormDialog
      trigger={house ? "Edit house" : "Add a house"}
      triggerVariant={house ? "secondary" : "primary"}
      title={house ? "Edit house" : "Add a house"}
      description={house ? undefined : "Then add its rooms and how many beds each has."}
      submitLabel="Save"
      action={action}
    >
      {(state) => (
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Name" error={err(state).name}>
            {(p) => (
              <Input
                {...p}
                name="name"
                maxLength={60}
                placeholder="e.g. Aggrey House"
                defaultValue={val(state).name ?? house?.name}
                required
              />
            )}
          </Field>
          <Field label="For" error={err(state).kind}>
            {(p) => (
              <Select {...p} name="kind" defaultValue={val(state).kind ?? house?.kind ?? "boys"}>
                {HOUSE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {HOUSE_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      )}
    </FormDialog>
  );
}

export function RoomDialog({ action }: { action: Action }) {
  return (
    <FormDialog
      trigger="Add a room"
      title="Add a room"
      description="Beds are numbered Bed 1, Bed 2, …"
      submitLabel="Add"
      action={action}
    >
      {(state) => (
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Room" error={err(state).name}>
            {(p) => (
              <Input
                {...p}
                name="name"
                maxLength={60}
                placeholder="e.g. Dormitory A"
                defaultValue={val(state).name}
                required
              />
            )}
          </Field>
          <Field label="Beds" error={err(state).beds}>
            {(p) => (
              <Input {...p} name="beds" inputMode="numeric" defaultValue={val(state).beds ?? "8"} required />
            )}
          </Field>
        </div>
      )}
    </FormDialog>
  );
}

export function BedsDialog({ action, room }: { action: Action; room: string }) {
  return (
    <FormDialog
      trigger="Add beds"
      triggerSize="sm"
      triggerLabel={`Add beds to ${room}`}
      title={`Add beds to ${room}`}
      submitLabel="Add"
      action={action}
    >
      {(state) => (
        <Field label="How many" error={err(state).beds}>
          {(p) => (
            <Input {...p} name="beds" inputMode="numeric" defaultValue={val(state).beds ?? "1"} required />
          )}
        </Field>
      )}
    </FormDialog>
  );
}

/** Giving a student a bed this term, or moving a boarder (BRD-01c). */
export function PlaceDialog({
  action,
  students,
  beds,
}: {
  action: Action;
  students: { id: string; name: string; className: string }[];
  beds: { id: string; label: string }[];
}) {
  const classes = [...new Set(students.map((s) => s.className))];
  return (
    <FormDialog
      trigger="Give a student a bed"
      triggerVariant="primary"
      title="Give a student a bed"
      description="For this term. Term billing charges the boarding fee to boarders."
      submitLabel="Save"
      action={action}
    >
      {(state) => (
        <div className="grid gap-5">
          <Field label="Student" error={err(state).studentId}>
            {(p) => (
              <Select {...p} name="studentId" defaultValue={val(state).studentId ?? ""} required>
                <option value="" disabled>
                  Choose a student
                </option>
                {classes.map((c) => (
                  <optgroup key={c} label={c}>
                    {students
                      .filter((s) => s.className === c)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Bed" error={err(state).bedId}>
            {(p) => (
              <Select {...p} name="bedId" defaultValue={val(state).bedId ?? ""} required>
                <option value="" disabled>
                  Choose a free bed
                </option>
                {beds.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      )}
    </FormDialog>
  );
}

export function AppointStaffForm({
  action,
  members,
}: {
  action: Action;
  members: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form
      action={formAction}
      className="flex flex-wrap items-end gap-3"
      noValidate
      aria-label="Appoint house staff"
    >
      <SuccessToast state={state} />
      <Field
        label="Appoint house staff"
        error={err(state).membershipId}
        className="min-w-0 grow basis-64 sm:max-w-sm"
      >
        {(p) => (
          <Select {...p} name="membershipId" defaultValue="" required>
            <option value="" disabled>
              Choose a member of staff
            </option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button type="submit" variant="secondary" pending={pending}>
        Appoint
      </Button>
    </form>
  );
}

/** Signing a boarder out on exeat (BRD-03). */
export function ExeatDialog({
  action,
  boarders,
  today,
}: {
  action: Action;
  boarders: { id: string; name: string; house: string }[];
  today: string;
}) {
  const houses = [...new Set(boarders.map((b) => b.house))];
  return (
    <FormDialog
      trigger="Sign a boarder out"
      triggerVariant="primary"
      title="Sign a boarder out"
      description="Sign them back in when they return. Both are kept as recorded."
      submitLabel="Sign out"
      action={action}
    >
      {(state) => {
        const e = err(state);
        const v = val(state);
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Boarder" error={e.studentId} className="sm:col-span-2">
              {(p) => (
                <Select {...p} name="studentId" defaultValue={v.studentId ?? ""} required>
                  <option value="" disabled>
                    Choose a boarder
                  </option>
                  {houses.map((h) => (
                    <optgroup key={h} label={h}>
                      {boarders
                        .filter((b) => b.house === h)
                        .map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Why" error={e.reason} className="sm:col-span-2">
              {(p) => (
                <Input
                  {...p}
                  name="reason"
                  maxLength={300}
                  placeholder="e.g. Family wedding"
                  defaultValue={v.reason}
                  required
                />
              )}
            </Field>
            <Field label="Collected by" error={e.collectedBy}>
              {(p) => (
                <Input
                  {...p}
                  name="collectedBy"
                  maxLength={120}
                  placeholder="e.g. Grace Mensah, mother"
                  defaultValue={v.collectedBy}
                  required
                />
              )}
            </Field>
            <Field label="Due back" error={e.expectedBackOn}>
              {(p) => (
                <Input
                  {...p}
                  name="expectedBackOn"
                  type="date"
                  min={today}
                  defaultValue={v.expectedBackOn}
                  required
                />
              )}
            </Field>
            <Field label="Note" optional error={e.note} className="sm:col-span-2">
              {(p) => <Input {...p} name="note" maxLength={300} defaultValue={v.note} />}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

export function FeeItemForm({
  action,
  items,
  current,
}: {
  action: Action;
  items: { id: string; name: string }[];
  current: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  return (
    <form
      action={formAction}
      className="flex flex-wrap items-end gap-3"
      noValidate
      aria-label="Boarding fee item"
    >
      <SuccessToast state={state} />
      <Field
        label="Boarding fee item"
        error={err(state).feeItemId}
        className="min-w-0 grow basis-64 sm:max-w-sm"
      >
        {(p) => (
          <Select {...p} name="feeItemId" defaultValue={current ?? ""}>
            <option value="">None: boarding is not billed from beds</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button type="submit" variant="secondary" pending={pending}>
        Save
      </Button>
    </form>
  );
}
