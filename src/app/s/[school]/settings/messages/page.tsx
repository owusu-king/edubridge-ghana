import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Section } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { getSchoolBilling } from "@/server/billing/subscriptions";
import { db } from "@/server/db/client";
import { getSchoolPreferences } from "@/server/tenancy/preferences";
import { paymentReceiptSms } from "@/lib/fee-messages";
import { minorToInput, moneyFormatter } from "@/lib/money";
import { requireTenant } from "@/web/auth";
import { saveMessageSettingsAction } from "./actions";
import { MessageSettingsForm } from "./messages-form";

export const metadata: Metadata = { title: "Settings · Messages" };

export default async function MessageSettingsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const showMoney = moneyFormatter(ctx.tenant.currencyCode);
  if (!allowed(ctx, "fees.manage")) notFound();
  const [prefs, billing] = await Promise.all([
    getSchoolPreferences(db(), ctx),
    allowed(ctx, "plan.view") ? getSchoolBilling(db(), ctx) : null,
  ]);
  const price = billing?.plan.smsPricePesewas;
  return (
    <Section
      title="Messages to families"
      description="SMS the school sends on its own. Announcements are sent from Announcements; absence SMS are set under Attendance."
    >
      {ctx.tenant.isDemo && (
        <p className="text-sm text-ink-3">This is a demo school: messages are recorded but never sent.</p>
      )}
      <MessageSettingsForm
        currency={ctx.tenant.currencyCode}
        action={saveMessageSettingsAction.bind(null, ctx.tenant.slug)}
        smsPrice={price !== null && price !== undefined ? showMoney(price) : null}
        example={paymentReceiptSms({
          schoolName: ctx.tenant.name,
          studentFirstName: "Ama",
          amountPesewas: 45_000,
          receiptNumber: "R000123",
          balancePesewas: 120_000,
        })}
        defaults={{
          paymentReceiptSms: prefs.paymentReceiptSms,
          autoRemindersEnabled: prefs.autoRemindersEnabled,
          autoReminderIntervalDays: prefs.autoReminderIntervalDays,
          autoReminderMin: minorToInput(prefs.autoReminderMinPesewas, ctx.tenant.currencyCode),
        }}
      />
    </Section>
  );
}
