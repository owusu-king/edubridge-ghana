import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Section } from "@/components/ui/layout";
import { allowed, ROLE_LABELS } from "@/server/authz/permissions";
import { requireTenant } from "@/web/auth";
import { db } from "@/server/db/client";
import { getSchoolPreferences } from "@/server/tenancy/preferences";
import { VoidPolicyForm } from "../preference-forms";
import { saveMfaPolicyAction, saveVoidPolicyAction } from "./actions";
import { MfaPolicyForm } from "./policy-form";

export const metadata: Metadata = { title: "Settings · Security" };

const POLICY_ROLES = ["owner", "headteacher", "admin", "bursar", "teacher"] as const;

export default async function SecuritySettingsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "security.manage")) notFound();
  const preferences = await getSchoolPreferences(db(), ctx);
  return (
    <div className="space-y-12">
      <Section
        title="Two-step verification"
        description="Recommended for anyone who can see fees or change who has access. Proprietors can change this policy."
      >
        <div className="max-w-xl">
          <MfaPolicyForm
            action={saveMfaPolicyAction.bind(null, ctx.tenant.slug)}
            options={POLICY_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
            selected={ctx.tenant.mfaRequiredRoles}
          />
        </div>
      </Section>
      <Section
        title="Voiding receipts"
        description="Who may void a receipt issued by mistake. The payment stays on record, marked void, with the reason."
      >
        <VoidPolicyForm
          action={saveVoidPolicyAction.bind(null, ctx.tenant.slug)}
          accountantsCanVoid={preferences.accountantsCanVoid}
        />
      </Section>
    </div>
  );
}
