/**
 * Seeds synthetic development data. Every person, school and email here is fictional.
 * Usage: npm run db:seed   (uses MIGRATION_DATABASE_URL; refuses to run in production)
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { hashPassword } from "../src/server/auth/password";
import type { Role } from "../src/server/authz/permissions";
import { memberships, tenants, users } from "../src/server/db/schema";

export const DEV_PASSWORD = "edubridge-dev-only";

const SCHOOLS = [
  { slug: "kpone-ridge", name: "Kpone Ridge International School" },
  { slug: "adenta-hall", name: "Adenta Hall Academy" },
];

const PEOPLE: { email: string; name: string; access: Record<string, Role[]> }[] = [
  {
    email: "owner@example.test",
    name: "Efua Mensah-Larbi",
    access: { "kpone-ridge": ["owner"], "adenta-hall": ["owner"] },
  },
  { email: "admin@example.test", name: "Kwabena Ofori", access: { "kpone-ridge": ["admin"] } },
  { email: "bursar@example.test", name: "Akosua Darko", access: { "kpone-ridge": ["bursar"] } },
  {
    email: "teacher@example.test",
    name: "Yaw Boateng",
    access: { "kpone-ridge": ["teacher"], "adenta-hall": ["teacher"] },
  },
  { email: "parent@example.test", name: "Abena Owusu", access: { "kpone-ridge": ["parent"] } },
  { email: "student@example.test", name: "Kojo Asante", access: { "kpone-ridge": ["student"] } },
];

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed a production environment.");
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is not set.");
  const pool = new Pool({ connectionString: url, max: 1 });
  const db = drizzle(pool);
  const passwordHash = await hashPassword(DEV_PASSWORD);

  try {
    const tenantIds = new Map<string, string>();
    for (const school of SCHOOLS) {
      const [row] = await db
        .insert(tenants)
        .values(school)
        .onConflictDoUpdate({ target: tenants.slug, set: { name: school.name } })
        .returning({ id: tenants.id });
      tenantIds.set(school.slug, row!.id);
    }

    for (const person of PEOPLE) {
      const [user] = await db
        .insert(users)
        .values({ email: person.email, name: person.name, passwordHash })
        .onConflictDoUpdate({ target: users.email, set: { name: person.name, passwordHash } })
        .returning({ id: users.id });
      for (const [slug, roles] of Object.entries(person.access)) {
        const tenantId = tenantIds.get(slug)!;
        await db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
          await tx
            .insert(memberships)
            .values({ tenantId, userId: user!.id, roles })
            .onConflictDoUpdate({
              target: [memberships.tenantId, memberships.userId],
              set: { roles, status: "active" },
            });
        });
      }
    }
    console.log(
      `Seeded ${SCHOOLS.length} schools and ${PEOPLE.length} users. Password for all: ${DEV_PASSWORD}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
