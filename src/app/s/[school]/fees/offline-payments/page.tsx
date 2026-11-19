import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Section } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listPaymentRoster } from "@/server/fees/payments";
import { getSchoolPreferences } from "@/server/tenancy/preferences";
import { todayIn } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { syncOperationsAction } from "../../sync-actions";
import { OfflinePayments } from "./offline-payments";

export const metadata: Metadata = { title: "Fees · Take payments offline" };

/**
 * Taking payments without a connection (only where the Proprietor allows it): a provisional receipt is
 * given at once and the payment is recorded, with the official receipt number, when the device reconnects.
 */
export default async function OfflinePaymentsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx, user } = await requireTenant(school);
  if (!allowed(ctx, "payments.record")) notFound();
  const prefs = await getSchoolPreferences(db(), ctx);
  if (!prefs.offlineReceiptsEnabled)
    return (
      <Section title="Take payments offline">
        <p className="max-w-2xl text-base text-ink-2">
          The Proprietor has not allowed payments to be taken without a connection (Settings, Security).
        </p>
      </Section>
    );
  const students = await listPaymentRoster(db(), ctx);
  return (
    <Section
      title="Take payments offline"
      description="Works without a connection once this page has been opened on this device. Give the payer the provisional receipt; the official receipt is issued when the device reconnects."
    >
      <OfflinePayments
        currency={ctx.tenant.currencyCode}
        school={ctx.tenant.slug}
        schoolName={ctx.tenant.name}
        userId={ctx.userId}
        userName={user.name}
        students={students}
        today={todayIn(ctx.tenant.timezone)}
        action={syncOperationsAction}
      />
    </Section>
  );
}
