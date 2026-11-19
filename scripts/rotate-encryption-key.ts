/**
 * Seals every stored secret again with the current MFA_ENCRYPTION_KEY: two-step verification seeds,
 * platform API keys (Admin, Integrations) and record-signing private keys. Run during a key rotation, with
 * the new key in MFA_ENCRYPTION_KEY and the old one in MFA_ENCRYPTION_KEY_PREVIOUS (see
 * docs/DEPLOYMENT-AND-OPERATIONS.md). Safe to run twice. Platform tables only accept changes from a
 * platform administrator, so one is named:
 *   npm run keys:rotate -- platform-admin@example.com
 * Uses MIGRATION_DATABASE_URL (the owner role). Prints counts only, never a secret.
 */
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { reseal } from "../src/server/auth/secret-box";
import { platformAdmins, platformSecrets, recordSigningKeys, userMfa, users } from "../src/server/db/schema";
import { loadLocalEnv } from "./load-env";

async function main() {
  const [email] = process.argv.slice(2);
  if (!email) throw new Error("Usage: keys:rotate -- <platform administrator email>");
  loadLocalEnv();
  if (!process.env.MFA_ENCRYPTION_KEY) throw new Error("MFA_ENCRYPTION_KEY (the new key) is not set.");
  if (!process.env.MFA_ENCRYPTION_KEY_PREVIOUS)
    console.warn(
      "MFA_ENCRYPTION_KEY_PREVIOUS is not set: only values already sealed with the new key will open.",
    );
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is not set.");
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const db = drizzle(pool);
    const [admin] = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(platformAdmins, eq(platformAdmins.userId, users.id))
      .where(eq(users.email, email));
    if (!admin) throw new Error(`${email} is not a platform administrator.`);
    // One transaction: if any value cannot be opened, nothing changes.
    const counts = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${admin.id}, true)`);
      let mfa = 0;
      for (const row of await tx.select().from(userMfa)) {
        await tx
          .update(userMfa)
          .set({ secretSealed: reseal(row.secretSealed) })
          .where(eq(userMfa.userId, row.userId));
        mfa++;
      }
      let secrets = 0;
      for (const row of await tx.select().from(platformSecrets)) {
        await tx
          .update(platformSecrets)
          .set({ sealed: reseal(row.sealed) })
          .where(eq(platformSecrets.name, row.name));
        secrets++;
      }
      let signing = 0;
      for (const row of await tx.select().from(recordSigningKeys)) {
        await tx
          .update(recordSigningKeys)
          .set({ privateKeySealed: reseal(row.privateKeySealed) })
          .where(eq(recordSigningKeys.keyId, row.keyId));
        signing++;
      }
      return { mfa, secrets, signing };
    });
    console.log(
      `Sealed again with the new key: ${counts.mfa} two-step secrets, ${counts.secrets} platform secrets, ${counts.signing} signing keys.`,
    );
    console.log(
      "Next: remove MFA_ENCRYPTION_KEY_PREVIOUS from the environment and restart the web and worker.",
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
