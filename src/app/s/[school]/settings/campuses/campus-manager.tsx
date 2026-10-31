"use client";

import { useActionState, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { StatusText } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import type { FormState } from "@/web/forms";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

export interface CampusRow {
  id: string;
  name: string;
  status: "active" | "archived";
  createdLabel: string;
  rename: Action;
  toggle: Action;
}

const initial: FormState = { status: "idle" };

export function AddCampusForm({ action, disabledReason }: { action: Action; disabledReason?: string }) {
  const [state, formAction, pending] = useActionState(action, initial);
  return (
    <form action={formAction} className="space-y-3" noValidate>
      {state.status !== "idle" && state.message && (
        <Alert tone={state.status === "success" ? "positive" : "critical"}>{state.message}</Alert>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <Field label="New campus name" error={state.fieldErrors?.name} className="flex-1">
          {(props) => (
            <Input
              {...props}
              name="name"
              defaultValue={state.values?.name}
              required
              maxLength={80}
              disabled={Boolean(disabledReason)}
              placeholder="e.g. East Legon"
            />
          )}
        </Field>
        <Button type="submit" pending={pending} disabled={Boolean(disabledReason)} className="sm:mt-6">
          Add campus
        </Button>
      </div>
      {disabledReason && <p className="text-sm text-ink-3">{disabledReason}</p>}
    </form>
  );
}

function RenameDialog({
  campus,
  open,
  onOpenChange,
}: {
  campus: CampusRow;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await campus.rename(prev, formData);
    if (result.status === "success") onOpenChange(false);
    return result;
  }, initial);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Rename campus">
      <form action={formAction} className="space-y-5" noValidate>
        {state.status === "error" && !state.fieldErrors && <Alert tone="critical">{state.message}</Alert>}
        <Field label="Campus name" error={state.fieldErrors?.name}>
          {(props) => (
            <Input
              {...props}
              name="name"
              defaultValue={state.values?.name ?? campus.name}
              required
              maxLength={80}
              autoFocus
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" pending={pending}>
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function StatusDialog({
  campus,
  open,
  onOpenChange,
}: {
  campus: CampusRow;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await campus.toggle(prev, formData);
    if (result.status === "success") onOpenChange(false);
    return result;
  }, initial);
  const archiving = campus.status === "active";
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={archiving ? `Archive ${campus.name}?` : `Restore ${campus.name}?`}
      description={
        archiving
          ? "Archived campuses are hidden from day-to-day work and do not count towards your plan. Nothing is deleted, and you can restore it later."
          : "The campus becomes active again and counts towards your plan's campus limit."
      }
    >
      <form action={formAction} className="space-y-5">
        {state.status === "error" && <Alert tone="critical">{state.message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant={archiving ? "danger" : "primary"} pending={pending}>
            {archiving ? "Archive campus" : "Restore campus"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function CampusTable({ campuses }: { campuses: CampusRow[] }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  return (
    <TableFrame>
      <Table>
        <caption className="sr-only">Campuses</caption>
        <THead>
          <tr>
            <TH>Campus</TH>
            <TH>Status</TH>
            <TH className="hidden sm:table-cell">Added</TH>
            <TH>
              <span className="sr-only">Actions</span>
            </TH>
          </tr>
        </THead>
        <TBody>
          {campuses.map((campus) => (
            <TR key={campus.id}>
              <TD className="font-medium text-ink">{campus.name}</TD>
              <TD>
                {campus.status === "active" ? (
                  <StatusText tone="positive">Active</StatusText>
                ) : (
                  <StatusText tone="neutral">Archived</StatusText>
                )}
              </TD>
              <TD className="hidden sm:table-cell">{campus.createdLabel}</TD>
              <TD className="text-right whitespace-nowrap">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setRenaming(campus.id)}
                  aria-label={`Rename ${campus.name}`}
                >
                  Rename
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setToggling(campus.id)}
                  aria-label={`${campus.status === "active" ? "Archive" : "Restore"} ${campus.name}`}
                >
                  {campus.status === "active" ? "Archive" : "Restore"}
                </Button>
                {renaming === campus.id && (
                  <RenameDialog campus={campus} open onOpenChange={(o) => !o && setRenaming(null)} />
                )}
                {toggling === campus.id && (
                  <StatusDialog campus={campus} open onOpenChange={(o) => !o && setToggling(null)} />
                )}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </TableFrame>
  );
}
