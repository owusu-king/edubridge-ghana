/**
 * Load check at pilot size: builds a demo school of the chosen size (timing each step, billing included),
 * then times the staff pages a Proprietor opens most, against a running production build.
 *
 *   npm run build && npx next start -p 3200            (in another terminal, same database)
 *   npm run perf:pilot -- --students=46 --url=http://localhost:3200
 *
 * --students is per class; the demo has 11 classes (KG 1 to JHS 3), so 46 makes about 500 students and
 * 182 about 2,000. --slug picks the school (default perf-<students>); an existing school is reused, so
 * pages can be timed again without rebuilding it. Use a throwaway database: this adds a demo school.
 */
import { and, eq, sql } from "drizzle-orm";
import { createSession } from "../src/server/auth/sessions";
import { createDatabase, type Database } from "../src/server/db/client";
import { classes, students, tenants, users } from "../src/server/db/schema";
import { generateDemoSchool } from "./demo/generate";
import { isEntrypoint, loadLocalEnv } from "./load-env";
import { DEV_PASSWORD } from "./seed";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const RUNS = 5;

async function timePage(baseUrl: string, path: string, cookie: string) {
  const times: number[] = [];
  let status = 0;
  let bytes = 0;
  // One warm-up request (first compile of the route's server code), then timed runs.
  for (let i = 0; i <= RUNS; i++) {
    const started = performance.now();
    const response = await fetch(baseUrl + path, { headers: { cookie }, redirect: "manual" });
    const body = await response.arrayBuffer();
    if (i > 0) times.push(performance.now() - started);
    status = response.status;
    bytes = body.byteLength;
  }
  times.sort((a, b) => a - b);
  return {
    path,
    status,
    kb: Math.round(bytes / 1024),
    median: times[Math.floor(times.length / 2)]!,
    max: times.at(-1)!,
  };
}

async function main() {
  loadLocalEnv();
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!ownerUrl || !appUrl) throw new Error("MIGRATION_DATABASE_URL and DATABASE_URL must both be set.");
  if (process.env.NODE_ENV === "production") throw new Error("Run this against a throwaway database only.");
  const perClass = Number(arg("students") ?? 46);
  const slug = arg("slug") ?? `perf-${perClass}`;
  const baseUrl = (arg("url") ?? "http://localhost:3200").replace(/\/$/, "");
  const owner = createDatabase(ownerUrl);
  const app = createDatabase(appUrl);
  try {
    const [existing] = await owner.db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug));
    if (!existing) {
      console.log(`Building ${slug} (${perClass} students per class):`);
      let last = Date.now();
      const started = last;
      await generateDemoSchool(
        { owner: owner.db, app: app.db },
        {
          slug,
          name: `Load check ${perClass} per class (Demo)`,
          password: DEV_PASSWORD,
          studentsPerClass: perClass,
          log: (message) => {
            const now = Date.now();
            console.log(`  ${((now - last) / 1000).toFixed(1).padStart(7)} s  ${message}`);
            last = now;
          },
        },
      );
      console.log(`  ${((Date.now() - started) / 1000).toFixed(1).padStart(7)} s  in all\n`);
    }
    await timePages(owner.db, slug, baseUrl);
  } finally {
    await Promise.all([owner.pool.end(), app.pool.end()]);
  }
}

async function timePages(owner: Database, slug: string, baseUrl: string) {
  const [school] = await owner.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug));
  const [proprietor] = await owner
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, `proprietor@${slug}.demo.test`));
  if (!school || !proprietor) throw new Error(`No demo school ${slug}.`);
  const ids = await owner.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${school.id}, true)`);
    const [cls] = await tx
      .select({ id: classes.id })
      .from(classes)
      .where(and(eq(classes.tenantId, school.id), eq(classes.name, "Basic 4")));
    const [student] = await tx
      .select({ id: students.id })
      .from(students)
      .where(eq(students.tenantId, school.id))
      .limit(1);
    const [{ count }] = (
      await tx.execute<{ count: number }>(
        sql`select count(*)::int as count from students where tenant_id = ${school.id}`,
      )
    ).rows as [{ count: number }];
    return { classId: cls?.id, studentId: student?.id, count };
  });
  const { token } = await createSession(owner, proprietor.id, { userAgent: "perf-pilot" });
  // Production builds use the __Host- cookie; development builds the plain name. Send both.
  const cookie = `__Host-eb_session=${token}; eb_session=${token}`;
  const s = `/s/${slug}`;
  const paths = [
    s,
    `${s}/students`,
    `${s}/students/${ids.studentId}`,
    `${s}/students/${ids.studentId}/statement`,
    `${s}/fees`,
    `${s}/fees/accounts`,
    `${s}/fees/owing`,
    `${s}/fees/payments`,
    `${s}/fees/families`,
    `${s}/fees/reports`,
    `${s}/fees/forecast`,
    `${s}/fees/checks`,
    `${s}/attendance`,
    `${s}/assessment/${ids.classId}`,
    `${s}/insights`,
    `${s}/early-warning`,
  ];
  console.log(`Pages for ${ids.count} students, as the Proprietor (${RUNS} runs each after one warm-up):`);
  console.log(`  ${"median".padStart(8)} ${"slowest".padStart(8)} ${"size".padStart(7)}  status  page`);
  for (const path of paths) {
    const r = await timePage(baseUrl, path, cookie);
    console.log(
      `  ${`${Math.round(r.median)} ms`.padStart(8)} ${`${Math.round(r.max)} ms`.padStart(8)} ${`${r.kb} KB`.padStart(7)}  ${String(r.status).padEnd(6)}  ${path.replace(s, "") || "/ (Command Center)"}`,
    );
  }
}

if (isEntrypoint(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
