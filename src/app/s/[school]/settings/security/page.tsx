import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Section } from "@/components/ui/layout";
import { can, ROLE_LABELS } from "@/server/authz/permissions";
import { requireTenant } from "@/web/auth";
import { saveMfaPolicyAction } from "./actions";
import { MfaPolicyForm } from "./policy-form";

export const metadata: Metadata = { title: "Settings · Security" };

const POLICY_ROLES = ["owner", "headteacher", "admin", "bursar", "teacher"] as const;

export default async function SecuritySettingsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "security.manage")) notFound();
  return (
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
  );
}
