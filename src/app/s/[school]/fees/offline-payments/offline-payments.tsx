"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { METHOD_OPTIONS } from "@/components/fees/finance-forms";
import { useSyncQueue, type SyncAction } from "@/components/sync/use-sync-queue";
import type { QueuedOperation } from "@/lib/sync/queue";
import { currencySymbol, formatMoney, parseMoney } from "@/lib/money";

interface Student {
  id: string;
  name: string;
  admissionNumber: string;
  className: string | null;
  balancePesewas: number;
}

interface Payload {
  studentId: string;
  amount: string;
  method: string;
  reference?: string;
  payerName?: string;
  paidOn: string;
  provisionalReference: string;
  confirmDuplicate?: boolean;
}

/** A per-device code and counter make provisional numbers unique: P-<8 hex>-<counter>. */
function nextProvisional(): string {
  let device = localStorage.getItem("edubridge-device-code");
  if (!device || !/^[0-9A-F]{8}$/.test(device)) {
    device = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
    localStorage.setItem("edubridge-device-code", device);
  }
  const n = Number(localStorage.getItem("edubridge-provisional-counter") ?? "0") + 1;
  localStorage.setItem("edubridge-provisional-counter", String(n));
  return `P-${device}-${String(n).padStart(4, "0")}`;
}

/** Taking payments without a connection: a provisional receipt now, the official receipt on reconnecting. */
export function OfflinePayments({
  currency,
  school,
  schoolName,
  userId,
  userName,
  students,
  today,
  action,
}: {
  /** The school's currency (ISO 4217). */
  currency: string;
  school: string;
  schoolName: string;
  userId: string;
  userName: string;
  students: Student[];
  today: string;
  action: SyncAction;
}) {
  const queue = useSyncQueue({ school, userId, scope: "payments:offline", action });
  const [query, setQuery] = useState("");
  const [studentId, setStudentId] = useState("");
  const [method, setMethod] = useState("cash");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ payload: Payload; student: Student } | null>(null);
  const byId = useMemo(() => new Map(students.map((s) => [s.id, s])), [students]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return students
      .filter((s) => s.name.toLowerCase().includes(q) || s.admissionNumber.toLowerCase().includes(q))
      .slice(0, 8);
  }, [query, students]);
  const chosen = byId.get(studentId);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const amount = String(data.get("amount") ?? "").trim();
    const reference = String(data.get("reference") ?? "").trim();
    if (!chosen) return setError("Choose the student.");
    if (!/^\d+(\.\d{1,2})?$/.test(amount.replace(/,/g, "")) || Number(amount.replace(/,/g, "")) <= 0)
      return setError("Enter the amount received, like 450 or 450.50.");
    if (method !== "cash" && !reference) return setError("Enter the transaction, slip or cheque number.");
    setError(null);
    const payload: Payload = {
      studentId: chosen.id,
      amount: amount.replace(/,/g, ""),
      method,
      ...(reference ? { reference } : {}),
      ...(String(data.get("payerName") ?? "").trim()
        ? { payerName: String(data.get("payerName")).trim() }
        : {}),
      paidOn: String(data.get("paidOn") ?? today),
      provisionalReference: nextProvisional(),
    };
    await queue.add({
      kind: "payment.record",
      payload,
      label: `${chosen.name}, ${formatMoney(parseMoney(String(payload.amount), currency) ?? 0, currency)}`,
    });
    setReceipt({ payload, student: chosen });
    event.currentTarget.reset();
    setStudentId("");
    setQuery("");
  }

  async function recordAnyway(op: QueuedOperation) {
    await queue.add({
      kind: "payment.record",
      payload: { ...(op.payload as Payload), confirmDuplicate: true },
      label: op.label,
    });
    await queue.remove(op.id);
  }

  const official = queue.lastApplied.filter((o) => o.outcome?.status === "applied");
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="space-y-6">
        <form
          onSubmit={onSubmit}
          noValidate
          className="max-w-xl space-y-5 print:hidden"
          aria-label="Take a payment"
        >
          {error && <Alert tone="critical">{error}</Alert>}
          <Field label="Student">
            {(p) => (
              <Input
                {...p}
                value={chosen ? `${chosen.name} (${chosen.admissionNumber})` : query}
                onChange={(e) => {
                  setStudentId("");
                  setQuery(e.target.value);
                }}
                placeholder="Name or admission number"
                autoComplete="off"
              />
            )}
          </Field>
          {!chosen && matches.length > 0 && (
            <ul className="divide-y divide-line rounded-md border border-line" aria-label="Matching students">
              {matches.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className="flex w-full justify-between gap-3 px-3 py-2 text-left text-base hover:bg-subtle"
                    onClick={() => setStudentId(s.id)}
                  >
                    <span>
                      {s.name} <span className="text-sm text-ink-3">{s.className ?? "No class"}</span>
                    </span>
                    <span className="text-sm text-ink-3 tabular-nums">{s.admissionNumber}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {chosen && (
            <p className="text-sm text-ink-3">
              Balance when this page was saved:{" "}
              {chosen.balancePesewas > 0
                ? `owes ${formatMoney(chosen.balancePesewas, currency)}`
                : "nothing owed"}
            </p>
          )}
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={`Amount (${currencySymbol(currency)})`}>
              {(p) => <Input {...p} name="amount" inputMode="decimal" required />}
            </Field>
            <Field label="Paid by">
              {(p) => (
                <Select {...p} name="method" value={method} onChange={(e) => setMethod(e.target.value)}>
                  {METHOD_OPTIONS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {method !== "cash" && (
            <Field label="Transaction, slip or cheque number">
              {(p) => <Input {...p} name="reference" maxLength={60} />}
            </Field>
          )}
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Received from" optional>
              {(p) => <Input {...p} name="payerName" maxLength={120} />}
            </Field>
            <Field label="Date received">
              {(p) => <Input {...p} name="paidOn" type="date" max={today} defaultValue={today} />}
            </Field>
          </div>
          <Button type="submit">Take payment</Button>
        </form>

        {receipt && (
          <section
            aria-label="Provisional receipt"
            className="max-w-xl space-y-2 rounded-lg border-2 border-dashed border-line-strong px-5 py-4"
          >
            <p className="text-xs font-semibold tracking-wide text-ink-3 uppercase">
              Provisional receipt: not an official receipt
            </p>
            <p className="text-md font-semibold text-ink">{schoolName}</p>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-base">
              <dt className="text-ink-3">Number</dt>
              <dd className="font-mono text-ink">{receipt.payload.provisionalReference}</dd>
              <dt className="text-ink-3">Student</dt>
              <dd className="text-ink">
                {receipt.student.name} ({receipt.student.admissionNumber})
              </dd>
              <dt className="text-ink-3">Amount</dt>
              <dd className="text-ink tabular-nums">
                {formatMoney(parseMoney(String(receipt.payload.amount), currency) ?? 0, currency)}
              </dd>
              <dt className="text-ink-3">Paid by</dt>
              <dd className="text-ink">{METHOD_OPTIONS.find(([v]) => v === receipt.payload.method)?.[1]}</dd>
              <dt className="text-ink-3">Date</dt>
              <dd className="text-ink">{receipt.payload.paidOn}</dd>
              <dt className="text-ink-3">Taken by</dt>
              <dd className="text-ink">{userName}</dd>
            </dl>
            <p className="text-sm text-ink-2">
              The official receipt, with the school&apos;s receipt number, is issued as soon as this device
              reconnects.
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => window.print()}
              className="print:hidden"
            >
              Print
            </Button>
          </section>
        )}
      </div>

      <aside className="space-y-6 print:hidden" aria-live="polite">
        {queue.error && <Alert tone="critical">{queue.error}</Alert>}
        <section aria-labelledby="waiting-payments" className="space-y-2">
          <h2 id="waiting-payments" className="text-md font-semibold text-ink">
            Waiting to send ({queue.pending.length})
          </h2>
          {queue.pending.length === 0 ? (
            <p className="text-sm text-ink-3">Nothing waiting on this device.</p>
          ) : (
            <ul className="space-y-1 text-sm text-ink-2">
              {queue.pending.map((op) => (
                <li key={op.id}>
                  {(op.payload as Payload).provisionalReference}: {op.label}
                </li>
              ))}
            </ul>
          )}
        </section>
        {queue.conflicts.length > 0 && (
          <section aria-labelledby="payments-decide" className="space-y-3">
            <h2 id="payments-decide" className="text-md font-semibold text-ink">
              Check these
            </h2>
            {queue.conflicts.map((op) => (
              <div
                key={op.id}
                className="space-y-2 rounded-lg border border-line-strong bg-subtle px-4 py-3 text-sm"
              >
                <p className="text-ink">
                  <strong>{op.label}</strong>:{" "}
                  {op.outcome?.status === "conflict"
                    ? String(op.outcome.result.duplicateReference ?? "")
                    : ""}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => void queue.remove(op.id)}
                  >
                    Same payment: discard
                  </Button>
                  <Button type="button" size="sm" variant="secondary" onClick={() => void recordAnyway(op)}>
                    Different payment: record
                  </Button>
                </div>
              </div>
            ))}
          </section>
        )}
        {queue.rejected.length > 0 && (
          <section aria-labelledby="payments-refused" className="space-y-2">
            <h2 id="payments-refused" className="text-md font-semibold text-ink">
              Not recorded
            </h2>
            {queue.rejected.map((op) => (
              <div key={op.id} className="rounded-lg border border-line-strong px-4 py-3 text-sm">
                <p className="text-ink">
                  <strong>{(op.payload as Payload).provisionalReference}</strong> ({op.label}):{" "}
                  {op.outcome?.status === "rejected" ? op.outcome.error.message : "Could not be recorded."}{" "}
                  Record it again from the student&apos;s page.
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
        {official.length > 0 && (
          <section aria-labelledby="payments-recorded" className="space-y-2">
            <h2 id="payments-recorded" className="text-md font-semibold text-ink">
              Recorded just now
            </h2>
            <ul className="space-y-1 text-sm text-ink-2">
              {official.map((op) => (
                <li key={op.id}>
                  {(op.payload as Payload).provisionalReference} → receipt{" "}
                  {op.outcome?.status === "applied" ? (
                    <a
                      className="text-accent underline"
                      href={`/s/${school}/fees/receipts/${String(op.outcome.result.paymentId)}`}
                    >
                      {String(op.outcome.result.receiptNumber)}
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        )}
      </aside>
    </div>
  );
}
