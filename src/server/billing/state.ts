import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { todayIn } from "../../lib/format";
import { BILLING_OK, billingState, type BillingState, type SubscriptionStatus } from "../../lib/plan";
import type { Queryable, Transaction } from "../db/client";
import { platformSettings, subscriptionInvoices, tenantEntitlements, tenants } from "../db/schema";

/**
 * Billing facts read on ordinary requests: platform settings (SMS price, grace days), a school's SMS price
 * and where it stands with EduBridge's invoices. No platform-admin code here, so the tenant context can use it.
 */

export interface PlatformSettings {
  smsPricePesewas: number | null;
  whatsappPricePesewas: number | null;
  graceDays: number;
}

export async function readPlatformSettings(db: Queryable): Promise<PlatformSettings> {
  const [row] = await db
    .select({
      smsPricePesewas: platformSettings.smsPricePesewas,
      whatsappPricePesewas: platformSettings.whatsappPricePesewas,
      graceDays: platformSettings.graceDays,
    })
    .from(platformSettings)
    .limit(1);
  return row ?? { smsPricePesewas: null, whatsappPricePesewas: null, graceDays: 3 };
}

/** The SMS price that applies to a school: its own, else the platform's; null when neither is set. */
/**
 * A school's price per SMS, in its own currency: its own price, else the platform's. The platform price is
 * in Ghana cedis, so it applies only to schools billed in GHS; others need their own (null until set).
 */
export async function smsPriceFor(tx: Transaction, tenantId: string): Promise<number | null> {
  const [plan] = await tx
    .select({ price: tenantEntitlements.smsPricePesewas })
    .from(tenantEntitlements)
    .where(eq(tenantEntitlements.tenantId, tenantId));
  if (plan?.price !== null && plan?.price !== undefined) return plan.price;
  const [tenant] = await tx
    .select({ currency: tenants.currencyCode })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return tenant?.currency === "GHS" ? (await readPlatformSettings(tx)).smsPricePesewas : null;
}

/** A school's price per WhatsApp message: the platform's, for schools billed in cedis; null otherwise or unset. */
export async function whatsappPriceFor(tx: Transaction, tenantId: string): Promise<number | null> {
  const [tenant] = await tx
    .select({ currency: tenants.currencyCode })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (tenant?.currency !== "GHS") return null;
  const [row] = await tx
    .select({ price: platformSettings.whatsappPricePesewas })
    .from(platformSettings)
    .limit(1);
  return row?.price ?? null;
}

/** Where the school stands with EduBridge's invoices today (inside its tenant transaction). */
export async function readBillingState(
  tx: Transaction,
  tenant: { id: string; timezone: string; isDemo: boolean },
): Promise<BillingState> {
  if (tenant.isDemo) return BILLING_OK;
  const [plan] = await tx
    .select({ status: tenantEntitlements.subscriptionStatus })
    .from(tenantEntitlements)
    .where(eq(tenantEntitlements.tenantId, tenant.id));
  const unpaid = await tx
    .select({ dueOn: subscriptionInvoices.dueOn })
    .from(subscriptionInvoices)
    .where(
      and(
        eq(subscriptionInvoices.tenantId, tenant.id),
        isNull(subscriptionInvoices.paidOn),
        isNull(subscriptionInvoices.voidedAt),
      ),
    );
  return billingState({
    manualStatus: (plan?.status ?? "trial") as SubscriptionStatus,
    unpaidDueDates: unpaid.map((u) => u.dueOn),
    today: todayIn(tenant.timezone),
    graceDays: (await readPlatformSettings(tx)).graceDays,
  });
}
