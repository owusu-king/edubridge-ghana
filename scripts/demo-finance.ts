/**
 * Adds a term of the school's own money to an existing demo school (new ones get it from npm run demo:school):
 *   npm run demo:finance                        (the school at /s/demo-academy)
 *   npm run demo:finance -- --slug=asante-hills-demo
 * Its bank account, cash box and Mobile Money wallet, the term's expenses, cash taken to the bank and the bank's
 * statement. Uses DATABASE_URL and goes through the app's own rules, as the school's Proprietor and Accountant.
 * Refuses a school that is not a demo, or one that already has finance accounts.
 */
import { and, eq } from "drizzle-orm";
import { getCurrentTerm } from "../src/server/academics/calendar";
import { createDatabase } from "../src/server/db/client";
import { tenants, users } from "../src/server/db/schema";
import { resolveTenantContext } from "../src/server/tenancy/service";
import { todayIn } from "../src/lib/format";
import { random } from "./demo/data";
import { generateDemoFinance } from "./demo/finance";
import { loadLocalEnv } from "./load-env";

async function main() {
  loadLocalEnv();
  const appUrl = process.env.DATABASE_URL;
  if (!appUrl) throw new Error("DATABASE_URL must be set.");
  const slug = process.argv.find((a) => a.startsWith("--slug="))?.slice("--slug=".length) ?? "demo-academy";
  const app = createDatabase(appUrl);
  try {
    const [school] = await app.db
      .select({ timezone: tenants.timezone })
      .from(tenants)
      .where(and(eq(tenants.slug, slug), eq(tenants.isDemo, true)))
      .limit(1);
    if (!school) throw new Error(`There is no demo school at /s/${slug}.`);
    const ctxFor = async (email: string) => {
      const [user] = await app.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      const ctx = user ? await resolveTenantContext(app.db, slug, user.id) : null;
      if (!ctx) throw new Error(`${email} is not a member of /s/${slug}.`);
      return ctx;
    };
    const proprietor = await ctxFor(`proprietor@${slug}.demo.test`);
    const bursar = await ctxFor(`accountant@${slug}.demo.test`);
    const term = await getCurrentTerm(app.db, proprietor);
    if (!term) throw new Error(`/s/${slug} has no current term.`);
    const summary = await generateDemoFinance({
      app: app.db,
      proprietor,
      bursar,
      rng: random(11),
      today: todayIn(school.timezone),
      termStart: term.startsOn,
      log: (m) => console.log(`  ${m}`),
    });
    console.log(
      `\nFinances added to /s/${slug}: ${summary.expenses} expenses, ${summary.deposits} deposits, ${summary.statementLines} statement lines.`,
    );
  } finally {
    await app.pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
