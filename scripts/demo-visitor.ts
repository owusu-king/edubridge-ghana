/**
 * Lets the landing page's "Try the demo school" open an existing demo school:
 *   npm run demo:visitor                        (the school at /s/demo-academy)
 *   npm run demo:visitor -- --slug=asante-hills-demo
 * Then set DEMO_SCHOOL_SLUG to the same address. New demo schools (npm run demo:school) get the visitor already.
 * Uses MIGRATION_DATABASE_URL. Changes nothing in the school itself; refuses a school that is not a demo.
 */
import { createDatabase } from "../src/server/db/client";
import { loadLocalEnv } from "./load-env";
import { addDemoVisitor } from "./demo/visitor";

async function main() {
  loadLocalEnv();
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) throw new Error("MIGRATION_DATABASE_URL must be set.");
  const slug = process.argv.find((a) => a.startsWith("--slug="))?.slice("--slug=".length) ?? "demo-academy";
  const owner = createDatabase(ownerUrl);
  try {
    const { email, created } = await addDemoVisitor(owner.db, slug);
    console.log(
      created
        ? `The demo visitor (${email}) can now look round /s/${slug}.`
        : `/s/${slug} already has its demo visitor (${email}).`,
    );
    console.log(`Set DEMO_SCHOOL_SLUG=${slug} to show "Try the demo school" on the landing page.`);
  } finally {
    await owner.pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
