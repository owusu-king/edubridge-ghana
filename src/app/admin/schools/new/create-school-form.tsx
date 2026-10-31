"use client";

import type { Route } from "next";
import Link from "next/link";
import { useState } from "react";
import { useFormAction } from "@/components/ui/use-form-action";
import { Alert } from "@/components/ui/alert";
import { Button, buttonStyles } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Section } from "@/components/ui/layout";
import { createSchoolAction, type InviteResult } from "../../actions";
import { InviteLinkPanel } from "@/components/ui/invite-link";

interface Options {
  countries: { code: string; name: string }[];
  currencies: readonly string[];
  timezones: readonly string[];
}

const toSlug = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");

export function CreateSchoolForm({ countries, currencies, timezones }: Options) {
  const { state, pending, onSubmit } = useFormAction<InviteResult>(createSchoolAction);
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const errors = state.fieldErrors ?? {};
  const v = state.values ?? {};

  if (state.status === "success" && state.data) {
    return (
      <div className="max-w-2xl space-y-6">
        <Alert tone="positive">School created with a Main campus and its plan.</Alert>
        <InviteLinkPanel result={state.data} />
        <div className="flex gap-2">
          <Link href={`/admin/schools/${state.data.schoolId}` as Route} className={buttonStyles("primary")}>
            View school
          </Link>
          <Link href={"/admin" as Route} className={buttonStyles("secondary")}>
            All schools
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="max-w-2xl space-y-10" noValidate>
      {state.status === "error" && state.message && <Alert tone="critical">{state.message}</Alert>}

      <Section title="School">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="School name" error={errors.name} className="sm:col-span-2">
            {(p) => (
              <Input
                {...p}
                name="name"
                defaultValue={v.name}
                required
                maxLength={120}
                onChange={(e) => !slugEdited && setSlug(toSlug(e.target.value))}
              />
            )}
          </Field>
          <Field
            label="Address"
            description="Used in the school's web address: /s/address"
            error={errors.slug}
            className="sm:col-span-2"
          >
            {(p) => (
              <Input
                {...p}
                name="slug"
                required
                value={slug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(e.target.value.toLowerCase());
                }}
                className="font-mono"
                autoCapitalize="none"
                spellCheck={false}
              />
            )}
          </Field>
          <Field label="Country" error={errors.countryCode}>
            {(p) => (
              <Select {...p} name="countryCode" defaultValue={v.countryCode ?? "GH"}>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Default currency" error={errors.currencyCode}>
            {(p) => (
              <Select {...p} name="currencyCode" defaultValue={v.currencyCode ?? "GHS"}>
                {currencies.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Time zone" error={errors.timezone} className="sm:col-span-2">
            {(p) => (
              <Select {...p} name="timezone" defaultValue={v.timezone ?? "Africa/Accra"}>
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace("_", " ")}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Section>

      <Section title="Plan">
        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="Plan name" error={errors.planName}>
            {(p) => (
              <Input {...p} name="planName" defaultValue={v.planName ?? "Pilot"} required maxLength={60} />
            )}
          </Field>
          <Field label="Campus limit" error={errors.maxCampuses}>
            {(p) => (
              <Input
                {...p}
                name="maxCampuses"
                type="number"
                inputMode="numeric"
                min={1}
                max={1000}
                defaultValue={v.maxCampuses ?? 1}
                required
              />
            )}
          </Field>
          <Field label="Student limit" description="Leave empty for no limit." error={errors.maxStudents}>
            {(p) => (
              <Input
                {...p}
                name="maxStudents"
                type="number"
                inputMode="numeric"
                min={1}
                defaultValue={v.maxStudents}
              />
            )}
          </Field>
        </div>
      </Section>

      <Section
        title="Proprietor"
        description="The proprietor receives a single-use link to create their account."
      >
        <Field label="Proprietor's email" error={errors.ownerEmail}>
          {(p) => (
            <Input
              {...p}
              name="ownerEmail"
              type="email"
              defaultValue={v.ownerEmail}
              required
              autoComplete="off"
            />
          )}
        </Field>
      </Section>

      <div className="flex justify-end gap-2 border-t border-line pt-5">
        <Link href={"/admin" as Route} className={buttonStyles("secondary")}>
          Cancel
        </Link>
        <Button type="submit" pending={pending}>
          Create school
        </Button>
      </div>
    </form>
  );
}
