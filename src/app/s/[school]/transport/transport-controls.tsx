"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { RIDE_DIRECTIONS, RIDE_DIRECTION_LABELS } from "@/lib/transport";
import type { FormState } from "@/web/forms";
import { SuccessToast } from "@/components/ui/toast";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

export interface VehicleValues {
  name: string;
  registration: string | null;
  seats: number | null;
  driverName: string | null;
  driverPhone: string | null;
  attendantName: string | null;
  attendantPhone: string | null;
  note: string | null;
}

/** Adding or changing a vehicle (TRN-01a). */
export function VehicleDialog({
  action,
  vehicle,
}: {
  action: Action;
  vehicle?: VehicleValues & { displayPhone: { driver: string; attendant: string } };
}) {
  return (
    <FormDialog
      trigger={vehicle ? "Edit" : "Add a vehicle"}
      triggerVariant={vehicle ? "secondary" : "primary"}
      triggerSize={vehicle ? "sm" : "md"}
      triggerLabel={vehicle ? `Edit ${vehicle.name}` : undefined}
      title={vehicle ? `Edit ${vehicle.name}` : "Add a vehicle"}
      submitLabel="Save"
      size="lg"
      action={action}
    >
      {(state) => {
        const e = state.fieldErrors ?? {};
        const v = state.values ?? {};
        const d = (key: string, current: string | number | null | undefined) =>
          v[key] ?? (current === null || current === undefined ? "" : String(current));
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Name" error={e.name}>
              {(p) => (
                <Input
                  {...p}
                  name="name"
                  maxLength={60}
                  placeholder="e.g. Bus 1"
                  defaultValue={d("name", vehicle?.name)}
                  required
                />
              )}
            </Field>
            <Field label="Registration" optional error={e.registration}>
              {(p) => (
                <Input
                  {...p}
                  name="registration"
                  maxLength={20}
                  defaultValue={d("registration", vehicle?.registration)}
                />
              )}
            </Field>
            <Field label="Seats" optional error={e.seats}>
              {(p) => (
                <Input {...p} name="seats" inputMode="numeric" defaultValue={d("seats", vehicle?.seats)} />
              )}
            </Field>
            <div className="hidden sm:block" />
            <Field label="Driver" optional error={e.driverName}>
              {(p) => (
                <Input
                  {...p}
                  name="driverName"
                  maxLength={120}
                  defaultValue={d("driverName", vehicle?.driverName)}
                />
              )}
            </Field>
            <Field label="Driver's phone" optional error={e.driverPhone}>
              {(p) => (
                <Input
                  {...p}
                  name="driverPhone"
                  type="tel"
                  inputMode="tel"
                  defaultValue={d("driverPhone", vehicle?.displayPhone.driver)}
                />
              )}
            </Field>
            <Field label="Attendant" optional error={e.attendantName}>
              {(p) => (
                <Input
                  {...p}
                  name="attendantName"
                  maxLength={120}
                  defaultValue={d("attendantName", vehicle?.attendantName)}
                />
              )}
            </Field>
            <Field label="Attendant's phone" optional error={e.attendantPhone}>
              {(p) => (
                <Input
                  {...p}
                  name="attendantPhone"
                  type="tel"
                  inputMode="tel"
                  defaultValue={d("attendantPhone", vehicle?.displayPhone.attendant)}
                />
              )}
            </Field>
            <Field label="Note" optional error={e.note} className="sm:col-span-2">
              {(p) => <Input {...p} name="note" maxLength={300} defaultValue={d("note", vehicle?.note)} />}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

/** Adding a route, or renaming it and changing its vehicle (TRN-01b). */
export function RouteDialog({
  action,
  vehicles,
  route,
}: {
  action: Action;
  vehicles: { id: string; name: string }[];
  route?: { name: string; vehicleId: string | null };
}) {
  return (
    <FormDialog
      trigger={route ? "Edit route" : "Add a route"}
      triggerVariant={route ? "secondary" : "primary"}
      title={route ? "Edit route" : "Add a route"}
      description={route ? undefined : "Add its stops next, in the order the bus passes them."}
      submitLabel="Save"
      action={action}
    >
      {(state) => {
        const e = state.fieldErrors ?? {};
        const v = state.values ?? {};
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Name" error={e.name}>
              {(p) => (
                <Input
                  {...p}
                  name="name"
                  maxLength={60}
                  placeholder="e.g. Tema Community 25"
                  defaultValue={v.name ?? route?.name}
                  required
                />
              )}
            </Field>
            <Field label="Vehicle" error={e.vehicleId}>
              {(p) => (
                <Select {...p} name="vehicleId" defaultValue={v.vehicleId ?? route?.vehicleId ?? ""}>
                  <option value="">Not chosen yet</option>
                  {vehicles.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

/** Adding or changing a stop: its name, place in the order and usual times. */
export function StopDialog({
  action,
  stop,
}: {
  action: Action;
  stop?: { name: string; sequence: number; morningTime: string | null; afternoonTime: string | null };
}) {
  return (
    <FormDialog
      trigger={stop ? "Edit" : "Add a stop"}
      triggerVariant={stop ? "secondary" : "primary"}
      triggerSize={stop ? "sm" : "md"}
      triggerLabel={stop ? `Edit ${stop.name}` : undefined}
      title={stop ? `Edit ${stop.name}` : "Add a stop"}
      submitLabel="Save"
      action={action}
    >
      {(state) => {
        const e = state.fieldErrors ?? {};
        const v = state.values ?? {};
        return (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Stop" error={e.name} className="sm:col-span-2">
              {(p) => (
                <Input
                  {...p}
                  name="name"
                  maxLength={80}
                  placeholder="e.g. Community 25 junction"
                  defaultValue={v.name ?? stop?.name}
                  required
                />
              )}
            </Field>
            <Field label="Morning time" optional error={e.morningTime}>
              {(p) => (
                <Input
                  {...p}
                  name="morningTime"
                  type="time"
                  defaultValue={v.morningTime ?? stop?.morningTime ?? ""}
                />
              )}
            </Field>
            <Field label="Afternoon time" optional error={e.afternoonTime}>
              {(p) => (
                <Input
                  {...p}
                  name="afternoonTime"
                  type="time"
                  defaultValue={v.afternoonTime ?? stop?.afternoonTime ?? ""}
                />
              )}
            </Field>
            <Field
              label="Order on the route"
              optional
              description="Blank: after the last stop."
              error={e.sequence}
            >
              {(p) => (
                <Input
                  {...p}
                  name="sequence"
                  inputMode="numeric"
                  defaultValue={v.sequence ?? (stop ? String(stop.sequence) : "")}
                />
              )}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

/** The route's fare per term and each stop's own fare where it differs (TRN-02a). */
export function FaresForm({
  action,
  currency,
  routeFare,
  stops,
}: {
  action: Action;
  currency: string;
  routeFare: string;
  stops: { id: string; name: string; fare: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, { status: "idle" } as FormState);
  const e = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="max-w-2xl space-y-5" noValidate>
      <SuccessToast state={state} />
      {state.status === "error" && !Object.keys(e).length && <Alert tone="critical">{state.message}</Alert>}
      <Field
        label={`Fare per term (${currency})`}
        description="Charged to each student on this route when the term is billed. Blank: no fare."
        error={e.fare}
        className="max-w-xs"
      >
        {(p) => (
          <Input {...p} name="fare" inputMode="decimal" defaultValue={state.values?.fare ?? routeFare} />
        )}
      </Field>
      {stops.length > 0 && (
        <fieldset className="space-y-3">
          <legend className="mb-1 text-sm font-medium text-ink">
            Stops with a different fare (blank: the route&apos;s)
          </legend>
          <div className="grid gap-4 sm:grid-cols-2">
            {stops.map((s) => (
              <Field key={s.id} label={s.name} error={e[`stop:${s.id}`]}>
                {(p) => (
                  <Input
                    {...p}
                    name={`stop:${s.id}`}
                    inputMode="decimal"
                    defaultValue={state.values?.[`stop:${s.id}`] ?? s.fare}
                  />
                )}
              </Field>
            ))}
          </div>
        </fieldset>
      )}
      <Button type="submit" variant="secondary" pending={pending}>
        Save fares
      </Button>
    </form>
  );
}

/** Putting a student on a route and stop for this term, or moving them (TRN-01c). */
export function AssignDialog({
  action,
  students,
  stops,
}: {
  action: Action;
  students: { id: string; name: string; className: string }[];
  stops: { id: string; route: string; name: string }[];
}) {
  const classes = [...new Set(students.map((s) => s.className))];
  const routes = [...new Set(stops.map((s) => s.route))];
  return (
    <FormDialog
      trigger="Put a student on a route"
      triggerVariant="primary"
      title="Put a student on a route"
      description="For this term. A student already on a route is moved, and the term's billing uses the new fare."
      submitLabel="Save"
      action={action}
    >
      {(state) => {
        const e = state.fieldErrors ?? {};
        const v = state.values ?? {};
        return (
          <div className="grid gap-5">
            <Field label="Student" error={e.studentId}>
              {(p) => (
                <Select {...p} name="studentId" defaultValue={v.studentId ?? ""} required>
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
            <Field label="Stop" error={e.stopId}>
              {(p) => (
                <Select {...p} name="stopId" defaultValue={v.stopId ?? ""} required>
                  <option value="" disabled>
                    Choose a stop
                  </option>
                  {routes.map((r) => (
                    <optgroup key={r} label={r}>
                      {stops
                        .filter((s) => s.route === r)
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
            <Field label="Rides" error={e.direction}>
              {(p) => (
                <Select {...p} name="direction" defaultValue={v.direction ?? "both"}>
                  {RIDE_DIRECTIONS.map((d) => (
                    <option key={d} value={d}>
                      {RIDE_DIRECTION_LABELS[d]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        );
      }}
    </FormDialog>
  );
}

/** Which optional fee item transport is billed as. */
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
    <form action={formAction} className="flex flex-wrap items-end gap-3" noValidate>
      <Field
        label="Transport fee item"
        error={state.fieldErrors?.feeItemId}
        className="min-w-0 grow basis-64 sm:max-w-sm"
      >
        {(p) => (
          <Select {...p} name="feeItemId" defaultValue={current ?? ""}>
            <option value="">None: transport is not billed from routes</option>
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
      <SuccessToast state={state} />
      <span aria-live="polite" className="text-sm text-critical">
        {!pending && state.status === "error" && !state.fieldErrors ? state.message : ""}
      </span>
    </form>
  );
}
