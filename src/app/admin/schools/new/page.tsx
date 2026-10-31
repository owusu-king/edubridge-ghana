import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/layout";
import { SUPPORTED_COUNTRIES, SUPPORTED_CURRENCIES } from "@/server/platform/service";
import { SUPPORTED_TIMEZONES } from "@/server/tenancy/service";
import { countryName } from "@/lib/format";
import { requirePlatformAdmin } from "@/web/auth";
import { CreateSchoolForm } from "./create-school-form";

export const metadata: Metadata = { title: "New school" };

export default async function NewSchoolPage() {
  await requirePlatformAdmin();
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Schools"
        title="New school"
        description="Creates the school, its plan, a Main campus and an owner invitation."
      />
      <CreateSchoolForm
        countries={SUPPORTED_COUNTRIES.map((code) => ({ code, name: countryName(code) }))}
        currencies={SUPPORTED_CURRENCIES}
        timezones={SUPPORTED_TIMEZONES}
      />
    </div>
  );
}
