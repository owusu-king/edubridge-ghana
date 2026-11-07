import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { todayIn } from "../../lib/format";
import { BILLING_OK, billingState, type BillingState, type SubscriptionStatus } from "../../lib/plan";
import type { Queryable, Transaction } from "../db/client";
import { platformSettings, subscriptionInvoices, tenantEntitlements } from "../db/schema";

/**
 * Billing facts read on ordinary requests: platform settings (SMS price, grace days), a school's SMS price
 * and where it stands with EduBridge's invoices. No platform-admin code here, so the tenant context can use it.
 */

export interface PlatformSettings {
  smsPricePesewas: number | null;
  graceDays: number;
}

export async function readPlatformSettings(db: Queryable): Promise<PlatformSettings> {
  const [row] = await db
    .select({ smsPricePesewas: platformSettings.smsPricePesewas, graceDays: platformSettings.graceDays })
    .from(platformSettings)
    .limit(1);
  return row ?? { smsPricePesewas: null, graceDays: 3 };
}

/** The SMS price that applies to a school: its own, else the platform's; null when neither is set. */
export async function smsPriceFor(tx: Transaction, tenantId: string): Promise<number | null> {
  const [plan] = await tx
    .select({ price: tenantEntitlements.smsPricePesewas })
    .from(tenantEntitlements)
    .where(eq(tenantEntitlements.tenantId, tenantId));
  return plan?.price ?? (await readPlatformSettings(tx)).smsPricePesewas;
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
