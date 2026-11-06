"use client";

import type { Route } from "next";
import Link from "next/link";
import { useState, useTransition } from "react";
import { FileDown, MessageCircle, MessageSquareText } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { feeReminderSms } from "@/lib/fee-messages";
import { formatCalendarDate } from "@/lib/format";
import { formatCedis } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import type { FormState } from "@/web/forms";

export interface OwingTableRow {
  studentId: string;
  name: string;
  firstName: string;
  admissionNumber: string;
  className: string | null;
  inactive: string | null;
  balancePesewas: number;
  overduePesewas: number;
  contactName: string | null;
  phone: string | null;
  lastPaidOn: string | null;
  lastRemindedOn: string | null;
  studentHref: Route;
  statementHref: string;
  whatsappHref: string | null;
}

/**
 * Students who owe, with selection for SMS reminders. A reminder costs the school an SMS, so sending
 * asks for confirmation and says who will be skipped (no phone, already reminded today).
 */
export function OwingTable({
  rows,
  canRemind,
  today,
  schoolName,
  linkPreview,
  send,
}: {
  rows: OwingTableRow[];
  canRemind: boolean;
  today: string;
  schoolName: string;
  /** How the private balance link looks in the message (each family gets its own). */
  linkPreview: string;
  send: (studentIds: string[]) => Promise<FormState>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<FormState | null>(null);
  const [pending, startTransition] = useTransition();
  const remindable = rows.filter((r) => r.phone && r.lastRemindedOn !== today);
  const chosen = rows.filter((r) => selected.has(r.studentId));
  const sending = chosen.filter((r) => r.phone && r.lastRemindedOn !== today);
  const willSend = sending.length;
  // The message as the first family will get it; each family's carries their own child and balance.
  const example = sending[0] ?? chosen[0];
  const allSelected = remindable.length > 0 && remindable.every((r) => selected.has(r.studentId));

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  function confirmSend() {
    startTransition(async () => {
      const outcome = await send(chosen.map((r) => r.studentId));
      setResult(outcome);
      setConfirming(false);
      if (outcome.status === "success") setSelected(new Set());
    });
  }

  return (
    <div className="space-y-4">
      {result?.message && (
        <Alert tone={result.status === "success" ? "positive" : "critical"}>{result.message}</Alert>
      )}
      {canRemind && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-base text-ink">
            <input
              type="checkbox"
              className="size-4 accent-ink"
              checked={allSelected}
              disabled={remindable.length === 0}
              onChange={() =>
                setSelected(allSelected ? new Set() : new Set(remindable.map((r) => r.studentId)))
              }
            />
            Select everyone who can be reminded
          </label>
          <Button
            size="sm"
            disabled={selected.size === 0}
            onClick={() => {
              setResult(null);
              setConfirming(true);
            }}
          >
            <MessageSquareText aria-hidden="true" />
            Send SMS reminder{selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
        </div>
      )}

      <TableFrame>
        <Table>
          <caption className="sr-only">Students who owe fees</caption>
          <THead>
            <tr>
              {canRemind && (
                <TH className="w-10">
                  <span className="sr-only">Select</span>
                </TH>
              )}
              <TH>Student</TH>
              <TH className="text-right">Owed</TH>
              <TH className="hidden md:table-cell">Contact</TH>
              <TH className="hidden lg:table-cell">Last paid</TH>
              <TH className="hidden lg:table-cell">Reminded</TH>
              <TH>
                <span className="sr-only">Actions</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {rows.map((r) => (
              <TR key={r.studentId}>
                {canRemind && (
                  <TD>
                    <input
                      type="checkbox"
                      className="size-4 accent-ink"
                      aria-label={r.phone ? `Select ${r.name}` : `${r.name} has no guardian phone number`}
                      title={r.phone ? undefined : "No guardian phone number"}
                      disabled={!r.phone}
                      checked={selected.has(r.studentId)}
                      onChange={() => toggle(r.studentId)}
                    />
                  </TD>
                )}
                <TD>
                  <Link href={r.studentHref} className="font-medium text-ink hover:underline">
                    {r.name}
                  </Link>
                  <span className="block font-mono text-xs text-ink-3">
                    {r.admissionNumber}
                    {r.inactive && ` · ${r.inactive}`}
                  </span>
                  <span className="block text-sm text-ink-3">{r.className ?? "Not in a class"}</span>
                </TD>
                <TD className="text-right whitespace-nowrap tabular-nums">
                  <span className="font-medium text-ink">{formatCedis(r.balancePesewas)}</span>
                  {r.overduePesewas > 0 && (
                    <span className="block text-sm font-medium text-critical">
                      {formatCedis(r.overduePesewas)} overdue on plan
                    </span>
                  )}
                </TD>
                <TD className="hidden md:table-cell">
                  {r.contactName ? (
                    <>
                      <span className="text-ink">{r.contactName}</span>
                      <span className="block text-sm text-ink-3">
                        {r.phone ? formatPhone(r.phone) : "No phone number"}
                      </span>
                    </>
                  ) : (
                    <span className="text-ink-3">No guardian recorded</span>
                  )}
                </TD>
                <TD className="hidden whitespace-nowrap lg:table-cell">
                  {r.lastPaidOn ? (
                    formatCalendarDate(r.lastPaidOn)
                  ) : (
                    <span className="text-ink-3">Never</span>
                  )}
                </TD>
                <TD className="hidden whitespace-nowrap lg:table-cell">
                  {r.lastRemindedOn ? (
                    r.lastRemindedOn === today ? (
                      "Today"
                    ) : (
                      formatCalendarDate(r.lastRemindedOn)
                    )
                  ) : (
                    <span className="text-ink-3">Not yet</span>
                  )}
                </TD>
                <TD className="text-right whitespace-nowrap">
                  <span className="inline-flex gap-1">
                    {canRemind && r.whatsappHref && (
                      <a
                        href={r.whatsappHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Message ${r.contactName ?? "the guardian"} about ${r.name} on WhatsApp`}
                        title="WhatsApp"
                        className="inline-flex size-9 items-center justify-center rounded-lg text-accent hover:bg-accent-soft"
                      >
                        <MessageCircle aria-hidden="true" className="size-4" />
                      </a>
                    )}
                    <a
                      href={r.statementHref}
                      aria-label={`Download ${r.name}'s statement`}
                      title="Statement (PDF)"
                      className="inline-flex size-9 items-center justify-center rounded-lg text-accent hover:bg-accent-soft"
                    >
                      <FileDown aria-hidden="true" className="size-4" />
                    </a>
                  </span>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableFrame>

      {confirming && (
        <Dialog
          open
          onOpenChange={setConfirming}
          title={`Send ${willSend === 1 ? "1 SMS reminder" : `${willSend} SMS reminders`}?`}
          description="Each guardian gets one text with a private link that shows the balance for 7 days. Families without a phone number, or already reminded today, are skipped."
        >
          <div className="space-y-5">
            <figure className="rounded-lg border border-line bg-subtle px-4 py-3">
              <figcaption className="mb-1 text-sm text-ink-3">
                {willSend > 1 ? `The message to ${example?.name}'s family, for example` : "The message"}
              </figcaption>
              {example && (
                <p className="text-base break-words text-ink">
                  {feeReminderSms({
                    schoolName,
                    studentFirstName: example.firstName,
                    balancePesewas: example.balancePesewas,
                    link: linkPreview,
                  })}
                </p>
              )}
            </figure>
            {chosen.length > willSend && (
              <p className="text-sm text-ink-2">
                {chosen.length - willSend} of the {chosen.length} selected will be skipped.
              </p>
            )}
            <div className="flex justify-end gap-2 border-t border-line pt-5">
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button pending={pending} disabled={willSend === 0} onClick={confirmSend}>
                Send {willSend === 1 ? "reminder" : "reminders"}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
