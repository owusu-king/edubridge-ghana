import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../audit/record";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { tenantEntitlements, tenants } from "../db/schema";
import { enqueue } from "../notifications/outbox";
import { proprietorEmails } from "./contacts";

/**
 * Automatic subscription status changes (SUB-05). The rules live in the database function
 * subscription_apply_automatic_status (migration 0088), which the app role may run but cannot bend: a trial
 * or paid period that has ended moves the school to grace, then to payment overdue once the platform's grace
 * period is over (which pauses SMS, as before); paying again (platform staff extend "paid until") makes it
 * active. Statuses set by hand stay unless the dates say the period is over. Each change is audited and the
 * Proprietors are emailed.
 */
export async function runSubscriptionStatusRules(
  database: Database,
  /** Only these schools (tests). */
  options: { only?: string[] } = {},
): Promise<{ checked: number; changed: number }> {
  const schools = await database
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
    .from(tenants)
    .where(
      and(
        eq(tenants.status, "active"),
        eq(tenants.isDemo, false),
        options.only ? inArray(tenants.id, options.only) : undefined,
      ),
    );
  let changed = 0;
  for (const school of schools) {
    const change = await withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => {
      const [plan] = await tx
        .select({ id: tenantEntitlements.tenantId })
        .from(tenantEntitlements)
        .where(eq(tenantEntitlements.tenantId, school.id));
      if (!plan) return null;
      const result = await tx.execute<{ from_status: string; to_status: "active" | "grace" | "past_due" }>(
        sql`select * from subscription_apply_automatic_status(${school.id})`,
      );
      const row = result.rows[0];
      if (!row) return null;
      await recordAudit(tx, {
        tenantId: school.id,
        actorUserId: null,
        action: "subscription.status_changed_automatically",
        entityType: "tenant",
        entityId: school.id,
        metadata: { from: row.from_status, to: row.to_status },
      });
      for (const email of await proprietorEmails(tx, school.id))
        await enqueue(tx, {
          channel: "email",
          recipient: email,
          template: "subscription_status",
          payload: { schoolName: school.name, schoolSlug: school.slug, status: row.to_status },
        });
      return row;
    });
    if (change) changed++;
  }
  return { checked: schools.length, changed };
}
