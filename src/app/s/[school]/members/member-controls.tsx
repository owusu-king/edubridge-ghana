"use client";

import { useState } from "react";
import { useFormAction } from "@/components/ui/use-form-action";
import { UserPlus } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/field";
import { InviteLinkPanel, type InviteLink } from "@/components/ui/invite-link";
import type { FormState } from "@/web/forms";

type Action<T = undefined> = (prev: FormState<T>, formData: FormData) => Promise<FormState<T>>;
export interface Option {
  value: string;
  label: string;
}

function ErrorMessage({ state }: { state: FormState<unknown> }) {
  return state.status === "error" && state.message ? <Alert tone="critical">{state.message}</Alert> : null;
}

/** Roles and campus scope, shared by the invite and edit dialogs. */
function AccessFields({
  roleOptions,
  campusOptions,
  defaults,
  errors,
}: {
  roleOptions: Option[];
  campusOptions: Option[];
  defaults: { roles: string[]; campusIds: string[] | null };
  errors: Record<string, string>;
}) {
  const [scope, setScope] = useState<"all" | "some">(defaults.campusIds ? "some" : "all");
  return (
    <>
      <fieldset className="space-y-2">
        <legend className="mb-1.5 text-sm font-medium text-ink">Roles</legend>
        {roleOptions.map((role) => (
          <label key={role.value} className="flex items-center gap-2.5 text-base text-ink">
            <input
              type="checkbox"
              name="roles"
              value={role.value}
              defaultChecked={defaults.roles.includes(role.value)}
              className="size-4 accent-ink"
            />
            {role.label}
          </label>
        ))}
        {errors.roles && <p className="text-sm text-critical">{errors.roles}</p>}
      </fieldset>
      {campusOptions.length > 1 && (
        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-sm font-medium text-ink">Campus access</legend>
          {(["all", "some"] as const).map((value) => (
            <label key={value} className="flex items-center gap-2.5 text-base text-ink">
              <input
                type="radio"
                name="campusScope"
                value={value}
                checked={scope === value}
                onChange={() => setScope(value)}
                className="size-4 accent-ink"
              />
              {value === "all" ? "All campuses" : "Only selected campuses"}
            </label>
          ))}
          {scope === "some" && (
            <div className="ml-6.5 space-y-2 border-l border-line pl-4">
              {campusOptions.map((campus) => (
                <label key={campus.value} className="flex items-center gap-2.5 text-base text-ink">
                  <input
                    type="checkbox"
                    name="campusIds"
                    value={campus.value}
                    defaultChecked={defaults.campusIds?.includes(campus.value)}
                    className="size-4 accent-ink"
                  />
                  {campus.label}
                </label>
              ))}
            </div>
          )}
          {errors.campusIds && <p className="text-sm text-critical">{errors.campusIds}</p>}
        </fieldset>
      )}
    </>
  );
}

export function InviteMemberDialog({
  action,
  roleOptions,
  campusOptions,
}: {
  action: Action<InviteLink>;
  roleOptions: Option[];
  campusOptions: Option[];
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <UserPlus aria-hidden="true" />
        Invite member
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setKey((k) => k + 1); // fresh form next time
        }}
        title="Invite a member"
        description="They receive a single-use link to join this school."
      >
        <InviteForm
          key={key}
          action={action}
          roleOptions={roleOptions}
          campusOptions={campusOptions}
          onDone={() => setOpen(false)}
        />
      </Dialog>
    </>
  );
}

function InviteForm({
  action,
  roleOptions,
  campusOptions,
  onDone,
}: {
  action: Action<InviteLink>;
  roleOptions: Option[];
  campusOptions: Option[];
  onDone: () => void;
}) {
  const { state, pending, onSubmit } = useFormAction(action);
  if (state.status === "success" && state.data) {
    return (
      <div className="space-y-5">
        <InviteLinkPanel result={state.data} />
        <div className="flex justify-end">
          <Button onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }
  const values = state.values ?? {};
  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {state.status === "error" && !state.fieldErrors && <ErrorMessage state={state} />}
      <Field label="Email" error={state.fieldErrors?.email}>
        {(p) => (
          <Input
            {...p}
            name="email"
            type="email"
            defaultValue={values.email}
            required
            autoComplete="off"
            autoFocus
          />
        )}
      </Field>
      <AccessFields
        roleOptions={roleOptions}
        campusOptions={campusOptions}
        defaults={{
          roles: state.values ? (values.roles?.split(",") ?? []) : ["teacher"],
          campusIds: values.campusScope === "some" ? (values.campusIds?.split(",") ?? []) : null,
        }}
        errors={state.fieldErrors ?? {}}
      />
      <div className="flex justify-end gap-2 border-t border-line pt-5">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" pending={pending}>
          Create invitation
        </Button>
      </div>
    </form>
  );
}

export function MemberActions({
  name,
  status,
  roles,
  campusIds,
  canEdit,
  canChangeStatus,
  roleOptions,
  campusOptions,
  update,
  toggleStatus,
}: {
  name: string;
  status: "active" | "suspended";
  roles: string[];
  campusIds: string[] | null;
  canEdit: boolean;
  canChangeStatus: boolean;
  roleOptions: Option[];
  campusOptions: Option[];
  update: Action;
  toggleStatus: Action;
}) {
  const [dialog, setDialog] = useState<"edit" | "status" | null>(null);
  const close = () => setDialog(null);
  return (
    <>
      {canEdit && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDialog("edit")}
          aria-label={`Edit access for ${name}`}
        >
          Edit
        </Button>
      )}
      {canChangeStatus && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDialog("status")}
          aria-label={`${status === "active" ? "Suspend" : "Reactivate"} ${name}`}
        >
          {status === "active" ? "Suspend" : "Reactivate"}
        </Button>
      )}
      {dialog === "edit" && (
        <Dialog open onOpenChange={(o) => !o && close()} title={`Edit access for ${name}`}>
          <EditForm
            action={update}
            onDone={close}
            roleOptions={roleOptions}
            campusOptions={campusOptions}
            defaults={{ roles, campusIds }}
          />
        </Dialog>
      )}
      {dialog === "status" && (
        <Dialog
          open
          onOpenChange={(o) => !o && close()}
          title={status === "active" ? `Suspend ${name}?` : `Reactivate ${name}?`}
          description={
            status === "active"
              ? "They lose access to this school on their next action. Their records and history are kept."
              : "They regain access with their previous roles."
          }
        >
          <ConfirmForm
            action={toggleStatus}
            onDone={close}
            label={status === "active" ? "Suspend member" : "Reactivate member"}
            danger={status === "active"}
          />
        </Dialog>
      )}
    </>
  );
}

function EditForm({
  action,
  onDone,
  roleOptions,
  campusOptions,
  defaults,
}: {
  action: Action;
  onDone: () => void;
  roleOptions: Option[];
  campusOptions: Option[];
  defaults: { roles: string[]; campusIds: string[] | null };
}) {
  const { state, pending, onSubmit } = useFormAction(async (prev: FormState, formData: FormData) => {
    const result = await action(prev, formData);
    if (result.status === "success") onDone();
    return result;
  });
  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {state.status === "error" && !state.fieldErrors?.roles && !state.fieldErrors?.campusIds && (
        <ErrorMessage state={state} />
      )}
      <AccessFields
        roleOptions={roleOptions}
        campusOptions={campusOptions}
        defaults={defaults}
        errors={state.fieldErrors ?? {}}
      />
      <div className="flex justify-end gap-2 border-t border-line pt-5">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" pending={pending}>
          Save access
        </Button>
      </div>
    </form>
  );
}

export function ConfirmForm({
  action,
  onDone,
  label,
  danger,
}: {
  action: Action;
  onDone: () => void;
  label: string;
  danger?: boolean;
}) {
  const { state, pending, onSubmit } = useFormAction(async (prev: FormState, formData: FormData) => {
    const result = await action(prev, formData);
    if (result.status === "success") onDone();
    return result;
  });
  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <ErrorMessage state={state} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant={danger ? "danger" : "primary"} pending={pending}>
          {label}
        </Button>
      </div>
    </form>
  );
}

export function InvitationActions({
  email,
  reissue,
  revoke,
}: {
  email: string;
  reissue: Action<InviteLink>;
  revoke: Action;
}) {
  const [dialog, setDialog] = useState<"link" | "revoke" | null>(null);
  const close = () => setDialog(null);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setDialog("link")}
        aria-label={`New link for ${email}`}
      >
        New link
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setDialog("revoke")}
        aria-label={`Revoke invitation for ${email}`}
      >
        Revoke
      </Button>
      {dialog === "link" && (
        <Dialog
          open
          onOpenChange={(o) => !o && close()}
          title={`New link for ${email}`}
          description="The previous link stops working."
        >
          <ReissueForm action={reissue} onDone={close} />
        </Dialog>
      )}
      {dialog === "revoke" && (
        <Dialog
          open
          onOpenChange={(o) => !o && close()}
          title={`Revoke invitation for ${email}?`}
          description="The link stops working immediately."
        >
          <ConfirmForm action={revoke} onDone={close} label="Revoke invitation" danger />
        </Dialog>
      )}
    </>
  );
}

function ReissueForm({ action, onDone }: { action: Action<InviteLink>; onDone: () => void }) {
  const { state, pending, onSubmit } = useFormAction(action);
  if (state.status === "success" && state.data) {
    return (
      <div className="space-y-5">
        <InviteLinkPanel result={state.data} />
        <div className="flex justify-end">
          <Button onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }
  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <ErrorMessage state={state} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" pending={pending}>
          Create new link
        </Button>
      </div>
    </form>
  );
}
