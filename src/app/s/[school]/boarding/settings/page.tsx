import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Section } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { getBoardingFeeSettings } from "@/server/boarding/houses";
import { db } from "@/server/db/client";
import { requireTenant } from "@/web/auth";
import { setFeeItemAction } from "../actions";
import { FeeItemForm } from "../boarding-controls";

export const metadata: Metadata = { title: "Boarding · Settings" };

/** How boarding is billed (BRD-02): for those who manage fees. */
export default async function BoardingSettingsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "boarding.view") || !allowed(ctx, "fees.manage")) notFound();
  const settings = await getBoardingFeeSettings(db(), ctx);
  return (
    <Section
      title="Fees"
      description="Boarding is billed as one of the school's optional fee items, at the amount set for each level or class under Fees. Billing the term charges it to every student with a bed that term, and to nobody else."
    >
      {settings.optionalItems.length === 0 ? (
        <p className="text-base text-ink-3">
          The school has no optional fee item yet. Add one called Boarding under Fees, Items, and mark it
          optional.
        </p>
      ) : (
        <FeeItemForm
          action={setFeeItemAction.bind(null, ctx.tenant.slug)}
          items={settings.optionalItems}
          current={settings.feeItemId}
        />
      )}
    </Section>
  );
}
