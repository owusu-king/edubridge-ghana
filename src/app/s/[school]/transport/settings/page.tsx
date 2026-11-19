import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChoiceForm } from "@/components/ui/action-forms";
import { Section } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getTransportSettings } from "@/server/transport/setup";
import { requireTenant } from "@/web/auth";
import { setFeeItemAction, setNotifyAction } from "../actions";
import { FeeItemForm } from "../transport-controls";

export const metadata: Metadata = { title: "Transport · Settings" };

/** How transport is billed (TRN-02a) and whether families are told about each trip (TRN-03b). */
export default async function TransportSettingsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "transport.view")) notFound();
  const slug = ctx.tenant.slug;
  const settings = await getTransportSettings(db(), ctx);
  const current = settings.optionalItems.find((i) => i.id === settings.feeItemId);

  return (
    <div className="space-y-10">
      <Section
        title="Fees"
        description="Transport is billed as one of the school's optional fee items. Billing the term charges it to each student on a route, at their stop's fare, and to nobody else."
      >
        {allowed(ctx, "fees.manage") ? (
          settings.optionalItems.length === 0 ? (
            <p className="text-base text-ink-3">
              The school has no optional fee item yet. Add one called Transport under Fees, Items, and mark it
              optional.
            </p>
          ) : (
            <FeeItemForm
              action={setFeeItemAction.bind(null, slug)}
              items={settings.optionalItems}
              current={settings.feeItemId}
            />
          )
        ) : (
          <p className="text-base text-ink">
            {current ? `Billed as ${current.name}.` : "Not billed from routes yet."}
            <span className="block text-sm text-ink-3">The Proprietor or Accountant chooses this.</span>
          </p>
        )}
      </Section>

      <Section title="Families">
        {allowed(ctx, "transport.manage") ? (
          <ChoiceForm
            action={setNotifyAction.bind(null, slug)}
            name="notify"
            label="When a child gets on or off the bus"
            value={settings.notifyFamilies ? "on" : "off"}
            options={[
              {
                value: "on",
                label: "Tell their family",
                description:
                  "A free notification to phones with notifications on, saying only that there is a bus update. The parent view shows the times.",
              },
              {
                value: "off",
                label: "Do not tell them",
                description: "The parent view still shows the times.",
              },
            ]}
          />
        ) : (
          <p className="text-base text-ink">
            {settings.notifyFamilies
              ? "Families are told when their child gets on or off."
              : "Families are not told."}
          </p>
        )}
      </Section>
    </div>
  );
}
