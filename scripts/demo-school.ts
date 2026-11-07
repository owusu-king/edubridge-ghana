/**
 * Creates a demonstration school full of made-up activity, for showing EduBridge to schools.
 *   npm run demo:school
 *   npm run demo:school -- --slug=asante-hills-demo --name="Asante Hills Academy" --students=28 --seed=7
 *   npm run demo:school -- --password="choose-a-long-password"
 * Uses MIGRATION_DATABASE_URL (to create the school and its staff accounts) and DATABASE_URL (everything
 * else, through the app's own rules). Never changes or removes an existing school: pick a new --slug.
 * The school is labelled as a demo on every page, sends no SMS or email, and is not in the parent view.
 */
import { randomBytes } from "node:crypto";
import { createDatabase } from "../src/server/db/client";
import { generateDemoSchool } from "./demo/generate";
import { DEV_PASSWORD } from "./seed";
import { loadLocalEnv } from "./load-env";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  loadLocalEnv();
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!ownerUrl || !appUrl) throw new Error("MIGRATION_DATABASE_URL and DATABASE_URL must both be set.");
  const production = process.env.NODE_ENV === "production";
  // Locally the seed's password keeps demos quick; anywhere else a strong one is generated unless given.
  const password = arg("password") ?? (production ? randomBytes(12).toString("base64url") : DEV_PASSWORD);
  if (password.length < 12) throw new Error("Use a password of at least 12 characters.");
  const owner = createDatabase(ownerUrl);
  const app = createDatabase(appUrl);
  const started = Date.now();
  try {
    const summary = await generateDemoSchool(
      { owner: owner.db, app: app.db },
      {
        slug: arg("slug") ?? "demo-academy",
        name: arg("name") ?? "Asante Hills Academy (Demo)",
        password,
        studentsPerClass: arg("students") ? Number(arg("students")) : undefined,
        seed: arg("seed") ? Number(arg("seed")) : undefined,
        log: (message) => console.log(`  ${message}`),
      },
    );
    console.log(`\nDemo school ready in ${Math.round((Date.now() - started) / 1000)} s: /s/${summary.slug}`);
    console.log(
      `${summary.students} students, ${summary.payments} payments, ${summary.registers} registers.`,
    );
    console.log("\nSign in with (two-step verification is off for this demo school):");
    for (const a of summary.accounts) console.log(`  ${a.role.padEnd(36)} ${a.email}`);
    console.log(
      `  Password: ${password === DEV_PASSWORD ? `${DEV_PASSWORD} (the development password)` : password}`,
    );
  } finally {
    await Promise.all([owner.pool.end(), app.pool.end()]);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
