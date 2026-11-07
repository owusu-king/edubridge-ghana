"use client";

import { useRef, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { useSyncQueue, type SyncAction } from "@/components/sync/use-sync-queue";
import type { QueuedOperation } from "@/lib/sync/queue";

const RELATIONSHIPS = [
  ["mother", "Mother"],
  ["father", "Father"],
  ["guardian", "Guardian"],
  ["grandparent", "Grandparent"],
  ["sibling", "Sibling"],
  ["other", "Other"],
] as const;

interface Duplicate {
  id: string;
  name: string;
  admissionNumber: string;
  status: string;
  dateOfBirth: string | null;
}

type Payload = Record<string, unknown> & { firstName?: string; lastName?: string };

const nameOf = (op: QueuedOperation) => {
  const p = op.payload as Payload;
  return [p.firstName, p.lastName].filter(Boolean).join(" ") || op.label;
};

/** The registration form and the children waiting on this device, registered, or needing a decision. */
export function OfflineRegistration({
  school,
  userId,
  classes,
  action,
}: {
  school: string;
  userId: string;
  classes: { id: string; name: string }[];
  action: SyncAction;
}) {
  const queue = useSyncQueue({ school, userId, scope: "students:register", action });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? "").trim();
    if (!text("firstName") || !text("lastName") || !text("sex")) {
      setError("Enter the first name and surname, and choose female or male.");
      return;
    }
    const guardianName = text("guardianName");
    const guardianPhone = text("guardianPhone");
    if ((guardianName || guardianPhone) && !(guardianName && guardianPhone)) {
      setError("Enter both the guardian's name and phone number, or neither.");
      return;
    }
    setError(null);
    const payload: Payload = {
      firstName: text("firstName"),
      otherNames: text("otherNames"),
      lastName: text("lastName"),
      sex: text("sex"),
      dateOfBirth: text("dateOfBirth"),
      classId: text("classId"),
      ...(guardianName
        ? {
            guardian: {
              fullName: guardianName,
              phone: guardianPhone,
              relationship: text("relationship") || "guardian",
            },
          }
        : {}),
    };
    await queue.add({ kind: "student.register", payload, label: `${payload.firstName} ${payload.lastName}` });
    setMessage(
      navigator.onLine
        ? `${payload.firstName} ${payload.lastName} is being registered.`
        : `${payload.firstName} ${payload.lastName} is kept on this device and will be registered when you are back online.`,
    );
    form.current?.reset();
    form.current?.querySelector<HTMLInputElement>("input[name=firstName]")?.focus();
  }

  /** A different child with the same name: send again, confirmed. */
  async function addAnyway(op: QueuedOperation) {
    await queue.add({
      kind: "student.register",
      payload: { ...(op.payload as Payload), confirmDuplicate: true },
      label: op.label,
    });
    await queue.remove(op.id);
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <form
        ref={form}
        onSubmit={onSubmit}
        noValidate
        className="max-w-2xl space-y-5"
        aria-label="Register a student"
      >
        {message && <Alert tone="positive">{message}</Alert>}
        {error && <Alert tone="critical">{error}</Alert>}
        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="First name">{(p) => <Input {...p} name="firstName" maxLength={60} required />}</Field>
          <Field label="Other names (optional)">
            {(p) => <Input {...p} name="otherNames" maxLength={60} />}
          </Field>
          <Field label="Surname">{(p) => <Input {...p} name="lastName" maxLength={60} required />}</Field>
        </div>
        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="Sex">
            {(p) => (
              <Select {...p} name="sex" defaultValue="" required>
                <option value="" disabled>
                  Choose
                </option>
                <option value="female">Female</option>
                <option value="male">Male</option>
              </Select>
            )}
          </Field>
          <Field label="Date of birth (optional)">
            {(p) => <Input {...p} name="dateOfBirth" type="date" />}
          </Field>
          <Field label="Class this term (optional)">
            {(p) => (
              <Select {...p} name="classId" defaultValue="">
                <option value="">Not yet</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <fieldset className="grid gap-5 sm:grid-cols-3">
          <legend className="mb-2 text-sm font-medium text-ink">Guardian (optional)</legend>
          <Field label="Guardian's name">{(p) => <Input {...p} name="guardianName" maxLength={100} />}</Field>
          <Field label="Phone">
            {(p) => <Input {...p} name="guardianPhone" inputMode="tel" maxLength={20} />}
          </Field>
          <Field label="Relationship">
            {(p) => (
              <Select {...p} name="relationship" defaultValue="mother">
                {RELATIONSHIPS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </fieldset>
        <Button type="submit">Register student</Button>
      </form>

      <aside className="space-y-6" aria-live="polite">
        {queue.error && <Alert tone="critical">{queue.error}</Alert>}
        <section aria-labelledby="waiting" className="space-y-2">
          <h2 id="waiting" className="text-md font-semibold text-ink">
            Waiting to send ({queue.pending.length})
          </h2>
          {queue.pending.length === 0 ? (
            <p className="text-sm text-ink-3">Nothing waiting on this device.</p>
          ) : (
            <ul className="space-y-1 text-sm text-ink-2">
              {queue.pending.map((op) => (
                <li key={op.id}>{nameOf(op)}</li>
              ))}
            </ul>
          )}
        </section>

        {queue.conflicts.length > 0 && (
          <section aria-labelledby="decide" className="space-y-3">
            <h2 id="decide" className="text-md font-semibold text-ink">
              Already on record?
            </h2>
            {queue.conflicts.map((op) => {
              const found =
                op.outcome?.status === "conflict"
                  ? ((op.outcome.result.possibleDuplicates as Duplicate[]) ?? [])
                  : [];
              return (
                <div
                  key={op.id}
                  className="space-y-2 rounded-lg border border-line-strong bg-subtle px-4 py-3"
                >
                  <p className="text-sm text-ink">
                    <strong>{nameOf(op)}</strong> may already be registered:
                  </p>
                  <ul className="text-sm text-ink-2">
                    {found.map((d) => (
                      <li key={d.id}>
                        {d.name}, {d.admissionNumber}
                        {d.dateOfBirth ? `, born ${d.dateOfBirth}` : ""}
                        {d.status !== "active" ? ` (${d.status})` : ""}
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => void queue.remove(op.id)}
                    >
                      Same child: discard
                    </Button>
                    <Button type="button" size="sm" variant="secondary" onClick={() => void addAnyway(op)}>
                      Different child: register
                    </Button>
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {queue.rejected.length > 0 && (
          <section aria-labelledby="not-saved" className="space-y-2">
            <h2 id="not-saved" className="text-md font-semibold text-ink">
              Not registered
            </h2>
            {queue.rejected.map((op) => (
              <div key={op.id} className="rounded-lg border border-line-strong px-4 py-3 text-sm">
                <p className="text-ink">
                  <strong>{nameOf(op)}</strong>:{" "}
                  {op.outcome?.status === "rejected"
                    ? (Object.values(op.outcome.error.fields ?? {})[0] ?? op.outcome.error.message)
                    : "Could not be registered."}
                </p>
                <button
                  type="button"
                  className="mt-1 font-medium text-accent underline"
                  onClick={() => void queue.remove(op.id)}
                >
                  Dismiss
                </button>
              </div>
            ))}
          </section>
        )}

        {queue.lastApplied.length > 0 && (
          <section aria-labelledby="registered" className="space-y-2">
            <h2 id="registered" className="text-md font-semibold text-ink">
              Registered just now
            </h2>
            <ul className="space-y-1 text-sm text-ink-2">
              {queue.lastApplied.map((op) => (
                <li key={op.id}>
                  {nameOf(op)}
                  {op.outcome?.status === "applied" ? `, ${String(op.outcome.result.admissionNumber)}` : ""}
                </li>
              ))}
            </ul>
          </section>
        )}
      </aside>
    </div>
  );
}
