import type { OperationOutcome, SyncOperation } from "./protocol";

/**
 * The device side of sync: changes are queued locally and sent in order when there is a connection.
 * Storage is behind `SyncStore`, so the same queue runs on IndexedDB in the browser (./indexeddb) and on
 * any other store a future client provides. Nothing here touches the network itself: the caller passes
 * how to send (a server action on the web, `POST /api/v1/schools/{school}/sync` elsewhere).
 */

export interface QueuedOperation extends SyncOperation {
  recordedAt: string;
  /** Whose change it is, and at which school: sent only while that person is signed in there. */
  userId: string;
  school: string;
  /** Groups operations for one screen, e.g. "scores:{term}:{class}:{subject}" or "students:register". */
  scope: string;
  /** For people: what this change is ("Marks for English, Basic 4A"). */
  label: string;
  /** pending: not sent yet; conflict / rejected: answered, waiting for the person. */
  state: "pending" | "conflict" | "rejected";
  outcome?: OperationOutcome;
}

export interface SyncStore {
  all(): Promise<QueuedOperation[]>;
  put(op: QueuedOperation): Promise<void>;
  remove(id: string): Promise<void>;
}

/** An in-memory store (tests, and clients without persistent storage). */
export function memoryStore(): SyncStore {
  const items = new Map<string, QueuedOperation>();
  return {
    all: async () => [...items.values()],
    put: async (op) => void items.set(op.id, structuredClone(op)),
    remove: async (id) => void items.delete(id),
  };
}

export const newOperationId = (): string => crypto.randomUUID();

export async function enqueue(
  store: SyncStore,
  op: Omit<QueuedOperation, "id" | "state" | "recordedAt"> & { id?: string; recordedAt?: string },
): Promise<QueuedOperation> {
  const queued: QueuedOperation = {
    ...op,
    id: op.id ?? newOperationId(),
    recordedAt: op.recordedAt ?? new Date().toISOString(),
    state: "pending",
  };
  await store.put(queued);
  return queued;
}

export async function listQueue(
  store: SyncStore,
  who: { userId: string; school: string },
  scope?: string,
): Promise<QueuedOperation[]> {
  return (await store.all())
    .filter((o) => o.userId === who.userId && o.school === who.school && (!scope || o.scope === scope))
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

/** Sends operations; throws when the server cannot be reached (they stay queued). */
export type Sender = (operations: SyncOperation[]) => Promise<OperationOutcome[]>;

export interface FlushSummary {
  applied: QueuedOperation[];
  conflicts: QueuedOperation[];
  rejected: QueuedOperation[];
  /** The server could not be reached: what was not sent stays queued. */
  offline: boolean;
}

const BATCH = 50;

/**
 * Sends this person's pending operations at this school, oldest first. Applied ones leave the queue;
 * conflicts and rejections stay, with the server's answer, until the person decides (see `dismiss`).
 */
export async function flush(
  store: SyncStore,
  who: { userId: string; school: string },
  send: Sender,
): Promise<FlushSummary> {
  const summary: FlushSummary = { applied: [], conflicts: [], rejected: [], offline: false };
  const pending = (await listQueue(store, who)).filter((o) => o.state === "pending");
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    let outcomes: OperationOutcome[];
    try {
      outcomes = await send(
        batch.map(({ id, kind, payload, recordedAt }) => ({ id, kind, payload, recordedAt })),
      );
    } catch {
      summary.offline = true;
      break;
    }
    const byId = new Map(outcomes.map((o) => [o.id, o]));
    for (const op of batch) {
      const outcome = byId.get(op.id);
      if (!outcome) continue;
      if (outcome.status === "applied") {
        await store.remove(op.id);
        summary.applied.push({ ...op, outcome });
      } else {
        const answered: QueuedOperation = { ...op, state: outcome.status, outcome };
        await store.put(answered);
        (outcome.status === "conflict" ? summary.conflicts : summary.rejected).push(answered);
      }
    }
  }
  return summary;
}

/** The person has dealt with a conflict or rejection (or discarded a change not yet sent). */
export async function dismiss(store: SyncStore, id: string): Promise<void> {
  await store.remove(id);
}

/** On sign-out: answered operations hold names from the server; changes still to send stay for their owner. */
export async function clearAnswered(store: SyncStore): Promise<void> {
  for (const op of await store.all()) if (op.state !== "pending") await store.remove(op.id);
}
