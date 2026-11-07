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
        title="Overview figures"
        description="How two figures on the Overview are worked out for your school."
      >
        <div className="max-w-2xl">
          <OverviewPreferencesForm
            action={saveOverviewPreferencesAction.bind(null, ctx.tenant.slug)}
            defaults={preferences}
          />
        </div>
      </Section>
    </div>
  );
}
