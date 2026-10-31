/**
 * Background worker: delivers queued email/SMS with retries. Run alongside the web process:
 *   npm run worker
 * Uses DATABASE_URL (the restricted application role).
 */
import { createDatabase } from "../src/server/db/client";
import { dispatchPending, releaseStuck } from "../src/server/notifications/outbox";
import { loadLocalEnv } from "./load-env";

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 5000);

async function main() {
  loadLocalEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const { db, pool } = createDatabase(url);
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log("worker started");
  while (running) {
    try {
      await releaseStuck(db);
      const { sent, failed } = await dispatchPending(db, { limit: 50 });
      if (sent || failed) console.log(`notifications: ${sent} sent, ${failed} failed`);
    } catch (error) {
      console.error("worker cycle failed", error instanceof Error ? error.message : error);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  await pool.end();
  console.log("worker stopped");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
