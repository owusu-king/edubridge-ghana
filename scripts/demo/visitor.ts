/**
 * The shared visitor account behind "Try the demo school" on the landing page (2026-11-19). It sees the demo
 * school as its Proprietor would, but can change nothing: the database makes its transactions read-only, it is
 * kept inside the school, and it can never belong to a school that is not a demo (database rules, migration
 * 0137). It has no password, so nobody can sign in with it; the landing page opens a short session for it.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../src/server/db/client";
import { demoVisitors, memberships, tenants, users } from "../../src/server/db/schema";

export const visitorEmail = (slug: string) => `visitor@${slug}.demo.test`;

/** Adds the visitor to a demo school, or confirms it is there. Uses the migration owner (it creates a user). */
export async function addDemoVisitor(
  owner: Database,
  slug: string,
): Promise<{ email: string; created: boolean }> {
  const [tenant] = await owner
    .select({ id: tenants.id, isDemo: tenants.isDemo })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  if (!tenant) throw new Error(`There is no school at /s/${slug}.`);
  if (!tenant.isDemo)
    throw new Error(`/s/${slug} is a real school, not a demo. A visitor is added only to demos.`);

  const email = visitorEmail(slug);
  const [user] = await owner
    .insert(users)
    .values({ email, name: "Demo visitor", passwordHash: null })
    .onConflictDoUpdate({ target: users.email, set: { passwordHash: null } })
    .returning({ id: users.id });
  await owner.insert(demoVisitors).values({ userId: user!.id }).onConflictDoNothing();
  const created = await owner.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenant.id}, true)`);
    const [existing] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, tenant.id), eq(memberships.userId, user!.id)))
      .limit(1);
    if (existing) return false;
    // The Proprietor's view, so every part of the school can be seen.
    await tx.insert(memberships).values({ tenantId: tenant.id, userId: user!.id, roles: ["owner"] });
    return true;
  });
  return { email, created };
}
