/**
 * Seeds synthetic development data. Every person, school and email here is fictional.
 * Usage: npm run db:seed   (uses MIGRATION_DATABASE_URL; refuses to run in production)
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { hashPassword } from "../src/server/auth/password";
import type { Role } from "../src/server/authz/permissions";
import {
  campuses,
  memberships,
  platformAdmins,
  tenantEntitlements,
  tenants,
  users,
} from "../src/server/db/schema";

export const DEV_PASSWORD = "edubridge-dev-only";

const SCHOOLS = [
  {
    slug: "kpone-ridge",
    name: "Kpone Ridge International School",
    maxCampuses: 3,
    campuses: ["Main campus", "Sakumono"],
  },
  { slug: "adenta-hall", name: "Adenta Hall Academy", maxCampuses: 1, campuses: ["Main campus"] },
];

const PLATFORM_ADMIN = { email: "platform@example.test", name: "Selorm Agbeko" };

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
    const [platformAdmin] = await db
      .insert(users)
      .values({ ...PLATFORM_ADMIN, passwordHash })
      .onConflictDoUpdate({ target: users.email, set: { name: PLATFORM_ADMIN.name, passwordHash } })
      .returning({ id: users.id });
    await db.insert(platformAdmins).values({ userId: platformAdmin!.id }).onConflictDoNothing();

    const tenantIds = new Map<string, string>();
    for (const school of SCHOOLS) {
      const [row] = await db
        .insert(tenants)
        .values({ slug: school.slug, name: school.name })
        .onConflictDoUpdate({ target: tenants.slug, set: { name: school.name } })
        .returning({ id: tenants.id });
      const tenantId = row!.id;
      tenantIds.set(school.slug, tenantId);
      // Plan limits may only be written as a platform administrator (enforced by row-level security).
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true), set_config('app.user_id', ${platformAdmin!.id}, true)`,
        );
        await tx
          .insert(tenantEntitlements)
          .values({ tenantId, planName: "Pilot", maxCampuses: school.maxCampuses })
          .onConflictDoUpdate({
            target: tenantEntitlements.tenantId,
            set: { maxCampuses: school.maxCampuses },
          });
        for (const name of school.campuses) {
          await tx.insert(campuses).values({ tenantId, name }).onConflictDoNothing();
        }
      });
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
      `Seeded ${SCHOOLS.length} schools, ${PEOPLE.length} school users and ${PLATFORM_ADMIN.email}. Password for all: ${DEV_PASSWORD}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
