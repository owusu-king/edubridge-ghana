/**
 * Background worker: delivers queued email/SMS with retries, settles Mobile Money prompts (stored
 * callbacks, then status checks of prompts still waiting), prints report cards in bulk, sends schools'
 * automatic fee reminders, and removes expired parent sign-ins and old print runs. Run alongside the web
 * process:
 *   npm run worker
 * Uses DATABASE_URL (the restricted application role).
 */
import { runReportCardWork } from "../src/server/assessment/batches";
import { createDatabase } from "../src/server/db/client";
import { runAutoReminders } from "../src/server/fees/reminders";
import { runMobileMoneyWork } from "../src/server/mobile-money/callbacks";
import { dispatchPending, releaseStuck } from "../src/server/notifications/outbox";
import { purgeParentSignIns } from "../src/server/parents/sessions";
import { purgeSyncChanges } from "../src/server/sync/changes";
import { renderReportCardsPdf } from "../src/web/pdf/report-card";
import { loadLocalEnv } from "./load-env";

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 5000);
/** Mobile Money work runs less often: it visits every school. */
const MOBILE_MONEY_INTERVAL_MS = Number(process.env.MOBILE_MONEY_POLL_MS ?? 15_000);
/** Report-card print runs (normally started straight after the request; this catches any left over). */
const REPORT_CARD_INTERVAL_MS = Number(process.env.REPORT_CARD_POLL_MS ?? 15_000);
/** Automatic fee reminders: checked every 15 minutes, sent once a school day per school after 9:00. */
const AUTO_REMINDER_INTERVAL_MS = 15 * 60 * 1000;
/** Expired parent sessions and old sign-in codes are removed hourly. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

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
  let lastMobileMoney = 0;
  let lastPurge = 0;
  let lastReportCards = 0;
  let lastAutoReminders = 0;
  while (running) {
    try {
      await releaseStuck(db);
      const { sent, failed } = await dispatchPending(db, { limit: 50 });
      if (sent || failed) console.log(`notifications: ${sent} sent, ${failed} failed`);
      if (Date.now() - lastMobileMoney >= MOBILE_MONEY_INTERVAL_MS) {
        lastMobileMoney = Date.now();
        const work = await runMobileMoneyWork(db);
        if (work.callbacks || work.checked || work.errors)
          console.log(
            `mobile money: ${work.callbacks} callbacks, ${work.checked} checked, ${work.recorded} recorded, ${work.errors} errors`,
          );
      }
      if (Date.now() - lastReportCards >= REPORT_CARD_INTERVAL_MS) {
        lastReportCards = Date.now();
        const printed = await runReportCardWork(db, (cards) => renderReportCardsPdf(cards));
        if (printed.batches || printed.removed || printed.errors)
          console.log(
            `report cards: ${printed.batches} print runs (${printed.classes} classes), ${printed.removed} old runs removed, ${printed.errors} errors`,
          );
      }
      if (Date.now() - lastAutoReminders >= AUTO_REMINDER_INTERVAL_MS) {
        lastAutoReminders = Date.now();
        const reminders = await runAutoReminders(db);
        if (reminders.schools)
          console.log(`automatic reminders: ${reminders.sent} queued for ${reminders.schools} schools`);
      }
      if (Date.now() - lastPurge >= PURGE_INTERVAL_MS) {
        lastPurge = Date.now();
        const purged = await purgeParentSignIns(db);
        if (purged.sessions || purged.codes)
          console.log(`parent sign-ins: ${purged.sessions} sessions and ${purged.codes} codes removed`);
        const changes = await purgeSyncChanges(db);
        if (changes) console.log(`sync: ${changes} change entries older than 90 days removed`);
      }
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
