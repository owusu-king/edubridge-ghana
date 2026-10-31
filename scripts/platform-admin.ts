/**
 * Grants or revokes platform administrator access. Platform access is never granted through the app.
 * Usage (owner role): npm run platform:admin -- grant someone@example.com
 *                     npm run platform:admin -- revoke someone@example.com
 */
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { platformAdmins, users } from "../src/server/db/schema";

async function main() {
  const [action, email] = process.argv.slice(2);
  if ((action !== "grant" && action !== "revoke") || !email) {
    throw new Error("Usage: platform:admin -- <grant|revoke> <email>");
  }
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is not set.");
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const db = drizzle(pool);
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (!user) throw new Error(`No user with email ${email}.`);
    if (action === "grant") {
      await db.insert(platformAdmins).values({ userId: user.id }).onConflictDoNothing();
    } else {
      await db.delete(platformAdmins).where(eq(platformAdmins.userId, user.id));
    }
    console.log(`${action === "grant" ? "Granted" : "Revoked"} platform administrator access for ${email}.`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
