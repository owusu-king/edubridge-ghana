import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Section } from "@/components/ui/layout";
import { getAbsenceAlertSettings } from "@/server/attendance/alerts";
import { allowed } from "@/server/authz/permissions";
import { getSchoolBilling } from "@/server/billing/subscriptions";
import { db } from "@/server/db/client";
import { formatCedis } from "@/lib/money";
import { requireTenant } from "@/web/auth";
import { saveAlertSettingsAction } from "./actions";
import { AbsenceAlertsForm } from "./alerts-form";

export const metadata: Metadata = { title: "Settings · Attendance" };

export default async function AttendanceSettingsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "attendance.manage")) notFound();
  const [settings, billing] = await Promise.all([
    getAbsenceAlertSettings(db(), ctx),
    allowed(ctx, "plan.view") ? getSchoolBilling(db(), ctx) : null,
  ]);
  const price = billing?.plan.smsPricePesewas;

  return (
    <Section
      title="Absence SMS"
      description="Let families know when a child keeps missing school. Nothing is sent until you turn this on."
    >
      {ctx.tenant.isDemo && (
        <p className="text-sm text-ink-3">This is a demo school: alerts are recorded but never sent.</p>
      )}
      <AbsenceAlertsForm
        action={saveAlertSettingsAction.bind(null, ctx.tenant.slug)}
        defaults={settings}
        schoolName={ctx.tenant.name}
        smsPrice={price !== null && price !== undefined ? formatCedis(price) : null}
      />
    </Section>
  );
}
