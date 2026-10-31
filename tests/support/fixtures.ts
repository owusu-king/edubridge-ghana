import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "@/server/db/client";
import { memberships, tenants, users } from "@/server/db/schema";
import { hashPassword } from "@/server/auth/password";
import type { Role } from "@/server/authz/permissions";
import { APP_URL, OWNER_URL } from "./db-urls";

/** Runtime connection (restricted role, RLS applies) and owner connection (fixtures only). */
export function connect() {
  const app = createDatabase(APP_URL);
  const owner = createDatabase(OWNER_URL);
  return {
    app: app.db,
    owner: owner.db,
    close: async () => {
      await Promise.all([app.pool.end(), owner.pool.end()]);
    },
  };
}

const unique = () => randomUUID().slice(0, 8);

export async function createTenant(owner: Database, name = "Synthetic Academy") {
  const [tenant] = await owner
    .insert(tenants)
    .values({ slug: `school-${unique()}`, name })
    .returning();
  return tenant!;
}

export const TEST_PASSWORD = "correct horse battery staple";
let cachedHash: Promise<string> | undefined;

export async function createUser(owner: Database, name = "Test User") {
  cachedHash ??= hashPassword(TEST_PASSWORD);
  const [user] = await owner
    .insert(users)
    .values({ email: `user-${unique()}@example.test`, name, passwordHash: await cachedHash })
    .returning();
  return user!;
}

/** Inserts a membership as the owner role; FORCE RLS requires the tenant context to be set. */
export async function addMember(owner: Database, tenantId: string, userId: string, roles: Role[]) {
  return owner.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    const [row] = await tx.insert(memberships).values({ tenantId, userId, roles }).returning();
    return row!;
  });
}
