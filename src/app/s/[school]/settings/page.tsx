import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DescriptionList, Section } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { SUPPORTED_TIMEZONES } from "@/server/tenancy/service";
import { countryName } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { db } from "@/server/db/client";
import { getSchoolPreferences } from "@/server/tenancy/preferences";
import { saveOverviewPreferencesAction, saveSchoolContactsAction, saveSchoolProfile } from "./actions";
import { OverviewPreferencesForm, SchoolContactsForm } from "./preference-forms";
import { ActionButton, UploadForm } from "@/components/ui/action-forms";
import {
  removeLogoAction,
  saveAdmissionFormatAction,
  saveBrandColorAction,
  uploadLogoAction,
} from "./identity-actions";
import { AdmissionFormatForm, BrandColorForm } from "./identity-forms";
import { formatPhone } from "@/lib/phone";
import { ProfileForm } from "./profile-form";
import { schoolPath } from "@/lib/routes";

export const metadata: Metadata = { title: "Settings · Profile" };

export default async function SettingsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "school.settings.manage")) notFound();
  const preferences = await getSchoolPreferences(db(), ctx);

  return (
    <div className="space-y-12">
      <div className="grid gap-10 lg:grid-cols-[1fr_20rem]">
        <Section title="School profile" description="Changes are recorded in the audit log.">
          <ProfileForm
            action={saveSchoolProfile.bind(null, ctx.tenant.slug)}
            defaults={{ name: ctx.tenant.name, timezone: ctx.tenant.timezone }}
            timezones={SUPPORTED_TIMEZONES}
          />
        </Section>
        <Section title="Fixed at setup" description="Set when the school was created.">
          <DescriptionList
            stacked
            items={[
              {
                term: "Address",
                detail: <span className="font-mono text-sm">{schoolPath(ctx.tenant.slug)}</span>,
              },
              { term: "Country", detail: countryName(ctx.tenant.countryCode) },
              { term: "Currency", detail: ctx.tenant.currencyCode },
            ]}
          />
        </Section>
      </div>
      <Section
        title="Contact details for families"
        description="Shown in the parent view, so families can call, message or email the school."
      >
        <div className="max-w-2xl">
          <SchoolContactsForm
            action={saveSchoolContactsAction.bind(null, ctx.tenant.slug)}
            defaults={{
              contactPhone: preferences.contactPhone ? formatPhone(preferences.contactPhone) : "",
              contactWhatsapp: preferences.contactWhatsapp ? formatPhone(preferences.contactWhatsapp) : "",
              contactEmail: preferences.contactEmail ?? "",
              officeHours: preferences.officeHours ?? "",
            }}
          />
        </div>
      </Section>
      <Section
        title="Command Center figures"
        description="How two figures on the Command Center are worked out for your school."
      >
        <div className="max-w-2xl">
          <OverviewPreferencesForm
            action={saveOverviewPreferencesAction.bind(null, ctx.tenant.slug)}
            defaults={preferences}
          />
        </div>
      </Section>
      {allowed(ctx, "school.settings.manage") && (
        <Section
          title="School identity"
          description="Your logo and colour appear in EduBridge, the parent view, receipts and statements. The colour must keep white text readable."
        >
          <div className="flex flex-wrap items-start gap-6">
            {preferences.logoFileId ? (
              // eslint-disable-next-line @next/next/no-img-element -- the school's own logo
              <img
                src={`/logo/${ctx.tenant.slug}?v=${preferences.logoFileId}`}
                alt="School logo"
                className="size-24 rounded-lg border border-line bg-surface object-contain p-1"
              />
            ) : (
              <div className="flex size-24 items-center justify-center rounded-lg border border-dashed border-line-strong text-sm text-ink-3">
                No logo
              </div>
            )}
            <div className="space-y-2">
              <UploadForm
                action={uploadLogoAction.bind(null, ctx.tenant.slug)}
                label={
                  preferences.logoFileId ? "Replace the logo" : "Add a logo (PNG, JPEG or WebP, up to 300 KB)"
                }
                accept="image/png,image/jpeg,image/webp"
                submitLabel="Upload"
              />
              {preferences.logoFileId && (
                <ActionButton action={removeLogoAction.bind(null, ctx.tenant.slug)} label="Remove logo" />
              )}
            </div>
          </div>
          <BrandColorForm
            action={saveBrandColorAction.bind(null, ctx.tenant.slug)}
            color={preferences.brandColor}
          />
        </Section>
      )}
      {allowed(ctx, "school.settings.manage") && (
        <Section title="Admission numbers" description="How new students' admission numbers are written.">
          <AdmissionFormatForm
            action={saveAdmissionFormatAction.bind(null, ctx.tenant.slug)}
            prefix={preferences.admissionPrefix ?? ""}
            digits={preferences.admissionDigits}
          />
        </Section>
      )}
    </div>
  );
}
