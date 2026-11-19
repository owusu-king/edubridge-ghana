import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Section } from "@/components/ui/layout";
import { getAbsenceAlertSettings } from "@/server/attendance/alerts";
import { allowed } from "@/server/authz/permissions";
import { getSchoolBilling } from "@/server/billing/subscriptions";
import { db } from "@/server/db/client";
import { moneyFormatter } from "@/lib/money";
import { requireTenant } from "@/web/auth";
import { ChoiceForm } from "@/components/ui/action-forms";
import { getSchoolPreferences } from "@/server/tenancy/preferences";
import { saveAlertSettingsAction, saveLessonAttendanceAction } from "./actions";
import { AbsenceAlertsForm } from "./alerts-form";

export const metadata: Metadata = { title: "Settings · Attendance" };

export default async function AttendanceSettingsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const showMoney = moneyFormatter(ctx.tenant.currencyCode);
  if (!allowed(ctx, "attendance.manage")) notFound();
  const [settings, billing, prefs] = await Promise.all([
    getAbsenceAlertSettings(db(), ctx),
    allowed(ctx, "plan.view") ? getSchoolBilling(db(), ctx) : null,
    getSchoolPreferences(db(), ctx),
  ]);
  const price = billing?.plan.smsPricePesewas;

  return (
    <div className="space-y-12">
      <Section
        title="Lesson registers"
        description="The daily class register is the school's attendance record. Some schools also take a register in every lesson, to see who missed which lessons."
      >
        <ChoiceForm
          action={saveLessonAttendanceAction.bind(null, ctx.tenant.slug)}
          name="lessonAttendance"
          label="Lesson registers"
          value={prefs.lessonAttendance ? "on" : "off"}
          options={[
            { value: "off", label: "Daily class registers only" },
            {
              value: "on",
              label: "Also a register in every timetabled lesson",
              description:
                "Each lesson's teacher marks who is there, from the timetable. Students at school but absent from a lesson are listed for academic staff. No SMS is sent for lessons.",
            },
          ]}
        />
      </Section>
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
          smsPrice={price !== null && price !== undefined ? showMoney(price) : null}
        />
      </Section>
    </div>
  );
}
