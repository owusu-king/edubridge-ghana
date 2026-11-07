"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { formatCalendarDate } from "@/lib/format";
import { listConflicts, listQueued, type ConflictEntry, type QueuedRegister } from "@/lib/offline-queue";
import { flushQueued, registerServiceWorker, savePagesForOffline, type SendRegister } from "./offline";
import { useOnline } from "./register-screen";

/**
 * On the attendance list: keeps today's registers ready for offline use, sends anything waiting on this
 * device, and lists registers that still need a decision.
 */
export function OfflineStatus({
  slug,
  userId,
  send,
  savePages,
  basePath,
}: {
  slug: string;
  userId: string;
  send: SendRegister;
  /** Register pages to keep for offline use (today's). */
  savePages: string[];
  basePath: string;
}) {
  const router = useRouter();
  const online = useOnline();
  const [queued, setQueued] = useState<QueuedRegister[]>([]);
  const [conflicts, setConflicts] = useState<ConflictEntry[]>([]);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    if (!("indexedDB" in window)) return;
    setQueued(await listQueued(userId, slug));
    setConflicts(await listConflicts(userId, slug));
  }, [userId, slug]);

  const flush = useCallback(async () => {
    const summary = await flushQueued(userId, slug, send);
    await refresh();
    if (summary.sent) router.refresh();
  }, [userId, slug, send, refresh, router]);

  useEffect(() => {
    registerServiceWorker();
    const start = setTimeout(async () => {
      await refresh();
      if (!navigator.onLine) return;
      await flush();
      if (savePages.length) {
        await navigator.serviceWorker?.ready;
        setSaved(await savePagesForOffline(savePages));
      }
    }, 0);
    const back = () => void flush();
    window.addEventListener("online", back);
    return () => {
      clearTimeout(start);
      window.removeEventListener("online", back);
    };
  }, [refresh, flush, savePages]);

  const href = (classId: string, date: string) => `${basePath}/${classId}?date=${date}`;
  return (
    <div className="space-y-3">
      {!online && (
        <Alert>
          No connection. Registers saved on this device still open, and marks are sent when you are back
          online.
        </Alert>
      )}
      {queued.length > 0 && (
        <Alert>
          {queued.length} {queued.length === 1 ? "register is" : "registers are"} kept on this device, not
          sent yet:{" "}
          {queued.map((q, i) => (
            <span key={q.key}>
              {i > 0 && ", "}
              <a className="font-medium underline" href={href(q.classId, q.date)}>
                {q.className}, {formatCalendarDate(q.date)}
              </a>
            </span>
          ))}
          .
        </Alert>
      )}
      {conflicts.length > 0 && (
        <Alert tone="critical">
          Someone else changed marks you also changed. Choose which to keep:{" "}
          {conflicts.map((c, i) => (
            <span key={c.key}>
              {i > 0 && ", "}
              <a className="font-medium underline" href={href(c.classId, c.date)}>
                {c.className}, {formatCalendarDate(c.date)}
              </a>
            </span>
          ))}
          .
        </Alert>
      )}
      {saved && online && (
        <p className="text-sm text-ink-3">
          Today&apos;s registers are saved on this device and open without a connection.
        </p>
      )}
    </div>
  );
}
