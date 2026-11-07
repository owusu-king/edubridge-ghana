"use client";

import type { SyncResult } from "@/server/attendance/registers";
import {
  addConflicts,
  clearConflicts,
  listQueued,
  queueMarks,
  registerKey,
  removeQueued,
  type QueuedMark,
  type QueuedRegister,
} from "@/lib/offline-queue";
import { indexedDbStore } from "@/lib/sync/indexeddb";
import { clearAnswered } from "@/lib/sync/queue";

/** What the register's server action answers. */
export type SyncAnswer = { ok: true; result: SyncResult } | { ok: false; message: string };
export type SendRegister = (payload: {
  classId: string;
  date: string;
  source: "online" | "offline" | "kept_mine";
  recordedAt?: string;
  marks: QueuedMark[];
}) => Promise<SyncAnswer>;

/** Registers the service worker (production builds only: in development it would cache stale pages). */
export function registerServiceWorker(): void {
  if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Offline pages are an enhancement; the app works without them.
  });
}

/**
 * Asks the service worker to keep these register pages (as they are now on the server) for offline use.
 * Resolves true once they are saved; false without a service worker, offline, or after 15 seconds.
 */
export async function savePagesForOffline(urls: string[]): Promise<boolean> {
  if (!("serviceWorker" in navigator) || !navigator.onLine || urls.length === 0) return false;
  const registration = await navigator.serviceWorker.getRegistration();
  const worker = registration?.active;
  if (!worker) return false;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 15_000);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve(true);
    };
    worker.postMessage({ type: "save-pages", urls: urls.map((u) => new URL(u, location.origin).href) }, [
      channel.port2,
    ]);
  });
}

/** On sign-out: drop saved pages and conflicts (they hold names). Marks still to send stay for their owner. */
export async function clearOfflineData(): Promise<void> {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "clear" });
    if ("caches" in window) await caches.delete("edubridge-pages-v1");
    if ("indexedDB" in window) {
      await clearConflicts();
      await clearAnswered(indexedDbStore());
    }
  } catch {
    // Nothing stored, or storage unavailable.
  }
}

/** True when an error means the request never reached the server. */
const unreachable = (error: unknown) => error instanceof TypeError || !navigator.onLine;

export interface Outcome {
  /** Kept on the device: not sent yet. */
  queued: boolean;
  result?: SyncResult;
  /** Refused by the server (e.g. too old to change); the marks were dropped. */
  refused?: string;
}

/** Sends marks now, or keeps them on the device when there is no connection. */
export async function sendOrQueue(
  send: SendRegister,
  entry: Omit<QueuedRegister, "key" | "recordedAt" | "source"> & { source: "online" | "kept_mine" },
): Promise<Outcome> {
  const keep = async () => {
    await queueMarks({ ...entry, source: entry.source === "kept_mine" ? "kept_mine" : "offline" });
    return { queued: true };
  };
  if (!navigator.onLine) return keep();
  try {
    const answer = await send({
      classId: entry.classId,
      date: entry.date,
      source: entry.source,
      marks: entry.marks,
    });
    if (!answer.ok) return { queued: false, refused: answer.message };
    await storeConflicts(entry, answer.result);
    return { queued: false, result: answer.result };
  } catch (error) {
    if (unreachable(error)) return keep();
    throw error;
  }
}

async function storeConflicts(
  entry: { userId: string; school: string; classId: string; className: string; date: string },
  result: SyncResult,
): Promise<void> {
  if (!result.conflicts.length) return;
  await addConflicts({
    key: registerKey(entry.userId, entry.school, entry.classId, entry.date),
    userId: entry.userId,
    school: entry.school,
    classId: entry.classId,
    className: entry.className,
    date: entry.date,
    items: result.conflicts,
  });
}

export interface FlushSummary {
  sent: number;
  conflicts: number;
  refused: { className: string; date: string; message: string }[];
  /** Still offline (or the server unreachable): nothing more was tried. */
  stopped: boolean;
}

/** Sends every register this user kept on the device for this school, oldest first. */
export async function flushQueued(userId: string, school: string, send: SendRegister): Promise<FlushSummary> {
  const summary: FlushSummary = { sent: 0, conflicts: 0, refused: [], stopped: false };
  if (!("indexedDB" in window)) return summary;
  const queued = (await listQueued(userId, school)).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  for (const entry of queued) {
    if (!navigator.onLine) {
      summary.stopped = true;
      break;
    }
    try {
      const answer = await send({
        classId: entry.classId,
        date: entry.date,
        source: entry.source,
        recordedAt: entry.recordedAt,
        marks: entry.marks,
      });
      await removeQueued(entry.key);
      if (!answer.ok) {
        summary.refused.push({ className: entry.className, date: entry.date, message: answer.message });
        continue;
      }
      await storeConflicts(entry, answer.result);
      summary.sent++;
      summary.conflicts += answer.result.conflicts.length;
    } catch (error) {
      if (unreachable(error)) {
        summary.stopped = true;
        break;
      }
      throw error;
    }
  }
  return summary;
}
