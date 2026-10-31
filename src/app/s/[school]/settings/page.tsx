import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DescriptionList, Section } from "@/components/ui/layout";
import { can } from "@/server/authz/permissions";
import { SUPPORTED_TIMEZONES } from "@/server/tenancy/service";
import { countryName } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { saveSchoolProfile } from "./actions";
import { ProfileForm } from "./profile-form";
import { schoolPath } from "@/lib/routes";

export const metadata: Metadata = { title: "Settings · Profile" };

export default async function SettingsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "school.settings.manage")) notFound();

  return (
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
  );
}
