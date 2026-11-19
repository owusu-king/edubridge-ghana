import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/layout";
import { COUNTRY_PROFILES } from "@/lib/countries";
import { SUPPORTED_COUNTRIES, SUPPORTED_CURRENCIES } from "@/server/platform/service";
import { SUPPORTED_TIMEZONES } from "@/server/tenancy/service";
import { countryName } from "@/lib/format";
import { listPresets } from "@/server/billing/plans";
import { db } from "@/server/db/client";
import { FEATURE_LABELS } from "@/lib/plan";
import { requirePlatformAdmin } from "@/web/auth";
import { CreateSchoolForm } from "./create-school-form";

export const metadata: Metadata = { title: "New school" };

export default async function NewSchoolPage() {
  const user = await requirePlatformAdmin();
  const presets = (await listPresets(db(), user.id)).filter((p) => !p.archived);
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Schools"
        title="New school"
        description="Creates the school, its plan, a Main campus and a proprietor invitation."
      />
      <CreateSchoolForm
        countries={SUPPORTED_COUNTRIES.map((code) => ({
          code,
          name: countryName(code),
          currency: COUNTRY_PROFILES[code].currency,
          timezone: COUNTRY_PROFILES[code].timezone,
        }))}
        currencies={SUPPORTED_CURRENCIES}
        timezones={SUPPORTED_TIMEZONES}
        presets={presets.map((p) => ({
          id: p.id,
          name: p.name,
          summary: [
            p.features.map((f) => FEATURE_LABELS[f].name).join(", ") || "Core records only",
            `${p.maxCampuses} ${p.maxCampuses === 1 ? "campus" : "campuses"}`,
            p.maxStudents === null ? "no student limit" : `up to ${p.maxStudents} students`,
          ].join(" · "),
        }))}
      />
    </div>
  );
}
