/**
 * Register marks kept on the device while offline (IndexedDB, browser only). One entry per register; a later
 * change to the same student replaces the earlier one but keeps the version it was first based on, because
 * the server has not seen either. Entries hold student ids and statuses only (no names), belong to the user
 * who made them, and are sent only while that user is signed in.
 *
 * Conflicts returned by the server are kept too, until the person decides each one.
 */
import type { AttendanceStatus } from "./attendance";

export interface QueuedMark {
  studentId: string;
  status: AttendanceStatus;
  reason: string | null;
  baseVersion: number;
}

export interface QueuedRegister {
  key: string;
  userId: string;
  school: string;
  classId: string;
  className: string;
  date: string;
  marks: QueuedMark[];
  source: "offline" | "kept_mine";
  /** When the marks were last changed on the device (ISO). */
  recordedAt: string;
}

export interface StoredConflict {
  studentId: string;
  name: string;
  yours: { status: AttendanceStatus; reason: string | null };
  theirs: { status: AttendanceStatus; reason: string | null; version: number; by: string | null; at: Date };
}

export interface ConflictEntry {
  key: string;
  userId: string;
  school: string;
  classId: string;
  className: string;
  date: string;
  items: StoredConflict[];
}

const DB = "edubridge-offline";
const QUEUE = "registers";
const CONFLICTS = "conflicts";

export const registerKey = (userId: string, school: string, classId: string, date: string) =>
  `${userId}:${school}:${classId}:${date}`;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(QUEUE, { keyPath: "key" });
      request.result.createObjectStore(CONFLICTS, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const all = <T>(store: string) => run<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);

export async function listQueued(userId: string, school: string): Promise<QueuedRegister[]> {
  return (await all<QueuedRegister>(QUEUE)).filter((q) => q.userId === userId && q.school === school);
}

export async function getQueued(key: string): Promise<QueuedRegister | undefined> {
  return run<QueuedRegister | undefined>(
    QUEUE,
    "readonly",
    (s) => s.get(key) as IDBRequest<QueuedRegister | undefined>,
  );
}

/** Adds marks to the register's queued entry, keeping each student's first base version. */
export async function queueMarks(entry: Omit<QueuedRegister, "key" | "recordedAt">): Promise<void> {
  const key = registerKey(entry.userId, entry.school, entry.classId, entry.date);
  const existing = await getQueued(key);
  const byStudent = new Map((existing?.marks ?? []).map((m) => [m.studentId, m]));
  for (const mark of entry.marks) {
    const earlier = byStudent.get(mark.studentId);
    byStudent.set(mark.studentId, { ...mark, baseVersion: earlier ? earlier.baseVersion : mark.baseVersion });
  }
  const value: QueuedRegister = {
    ...entry,
    // Keeping one's own mark after a conflict is an explicit decision and stays recorded as such.
    source: existing?.source === "kept_mine" || entry.source === "kept_mine" ? "kept_mine" : "offline",
    key,
    marks: [...byStudent.values()],
    recordedAt: new Date().toISOString(),
  };
  await run(QUEUE, "readwrite", (s) => s.put(value));
}

export async function removeQueued(key: string): Promise<void> {
  await run(QUEUE, "readwrite", (s) => s.delete(key));
}

export async function listConflicts(userId: string, school: string): Promise<ConflictEntry[]> {
  return (await all<ConflictEntry>(CONFLICTS)).filter((c) => c.userId === userId && c.school === school);
}

export async function getConflicts(key: string): Promise<ConflictEntry | undefined> {
  return run<ConflictEntry | undefined>(
    CONFLICTS,
    "readonly",
    (s) => s.get(key) as IDBRequest<ConflictEntry | undefined>,
  );
}

/** Stores new conflicts for a register; a newer conflict for the same student replaces the older one. */
export async function addConflicts(entry: ConflictEntry): Promise<void> {
  const existing = await getConflicts(entry.key);
  const byStudent = new Map((existing?.items ?? []).map((c) => [c.studentId, c]));
  for (const item of entry.items) byStudent.set(item.studentId, item);
  await run(CONFLICTS, "readwrite", (s) => s.put({ ...entry, items: [...byStudent.values()] }));
}

/** Removes one decided conflict (or the whole entry when none are left). */
export async function resolveConflict(key: string, studentId: string): Promise<void> {
  const existing = await getConflicts(key);
  if (!existing) return;
  const items = existing.items.filter((c) => c.studentId !== studentId);
  if (items.length) await run(CONFLICTS, "readwrite", (s) => s.put({ ...existing, items }));
  else await run(CONFLICTS, "readwrite", (s) => s.delete(key));
}

/** On sign-out: conflicts carry student names, so they go; queued marks (ids only) stay for their owner. */
export async function clearConflicts(): Promise<void> {
  await run(CONFLICTS, "readwrite", (s) => s.clear());
}
