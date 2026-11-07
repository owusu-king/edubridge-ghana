"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { indexedDbStore } from "@/lib/sync/indexeddb";
import type { OperationOutcome, SyncOperation } from "@/lib/sync/protocol";
import { dismiss, enqueue, flush, listQueue, type QueuedOperation, type SyncStore } from "@/lib/sync/queue";

export type SyncAction = (
  slug: string,
  operations: SyncOperation[],
) => Promise<{ ok: true; outcomes: OperationOutcome[] } | { ok: false; message: string }>;

let store: SyncStore | null = null;
const browserStore = () => (store ??= indexedDbStore());

/**
 * One screen's offline changes: queued on the device, sent when there is a connection (on load, when the
 * browser comes back online, and every 30 seconds while anything waits), with the server's answers kept
 * for the person to decide.
 */
export function useSyncQueue(opts: { school: string; userId: string; scope: string; action: SyncAction }) {
  const { school, userId, scope, action } = opts;
  const [items, setItems] = useState<QueuedOperation[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastApplied, setLastApplied] = useState<QueuedOperation[]>([]);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (!("indexedDB" in window)) return;
    setItems(await listQueue(browserStore(), { userId, school }, scope));
  }, [school, userId, scope]);

  const send = useCallback(async () => {
    if (busy.current || !("indexedDB" in window) || !navigator.onLine) return;
    busy.current = true;
    setSending(true);
    try {
      const summary = await flush(browserStore(), { userId, school }, async (operations) => {
        const answer = await action(school, operations);
        if (!answer.ok) {
          setError(answer.message);
          return [];
        }
        setError(null);
        return answer.outcomes;
      });
      if (summary.applied.length) setLastApplied(summary.applied.filter((a) => a.scope === scope));
      await refresh();
      return summary;
    } finally {
      busy.current = false;
      setSending(false);
    }
  }, [action, refresh, school, scope, userId]);

  useEffect(() => {
    // Read the device's queue after mounting (IndexedDB is browser-only), then send what waits.
    const first = setTimeout(() => void refresh().then(send), 0);
    const online = () => void send();
    window.addEventListener("online", online);
    const timer = setInterval(() => void send(), 30_000);
    return () => {
      clearTimeout(first);
      window.removeEventListener("online", online);
      clearInterval(timer);
    };
  }, [refresh, send]);

  const add = useCallback(
    async (op: Pick<QueuedOperation, "kind" | "payload" | "label">) => {
      const queued = await enqueue(browserStore(), { ...op, userId, school, scope });
      await refresh();
      void send();
      return queued;
    },
    [refresh, school, scope, send, userId],
  );

  const remove = useCallback(
    async (id: string) => {
      await dismiss(browserStore(), id);
      await refresh();
    },
    [refresh],
  );

  return {
    pending: items.filter((i) => i.state === "pending"),
    conflicts: items.filter((i) => i.state === "conflict"),
    rejected: items.filter((i) => i.state === "rejected"),
    lastApplied,
    sending,
    error,
    add,
    remove,
    send,
  };
}
