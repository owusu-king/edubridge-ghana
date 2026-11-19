import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Section } from "@/components/ui/layout";
import { allowed, ROLE_LABELS } from "@/server/authz/permissions";
import { requireTenant } from "@/web/auth";
import { db } from "@/server/db/client";
import { getSchoolPreferences } from "@/server/tenancy/preferences";
import { SwitchesForm, VoidPolicyForm } from "../preference-forms";
import { saveMfaPolicyAction, saveOfflineReceiptsAction, saveVoidPolicyAction } from "./actions";
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
      <Section
        title="Payments without a connection"
        description="Lets Accountants take payments when the internet is down. The payer gets a provisional receipt on the spot; the official receipt, with the school's next receipt number, is issued as soon as the device reconnects."
      >
        <SwitchesForm
          action={saveOfflineReceiptsAction.bind(null, ctx.tenant.slug)}
          switches={[
            {
              name: "offlineReceiptsEnabled",
              label: "Allow provisional receipts offline",
              note: "Off by default. Provisional receipts are marked as such; amounts reach the ledger only when they are sent, and each is audited.",
              checked: preferences.offlineReceiptsEnabled,
            },
          ]}
        />
      </Section>
    </div>
  );
}
