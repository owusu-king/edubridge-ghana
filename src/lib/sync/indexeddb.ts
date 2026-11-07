import type { QueuedOperation, SyncStore } from "./queue";

/** The browser's sync queue store (IndexedDB database "edubridge-sync"). */
const DB = "edubridge-sync";
const STORE = "operations";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function indexedDbStore(): SyncStore {
  return {
    all: () => run<QueuedOperation[]>("readonly", (s) => s.getAll() as IDBRequest<QueuedOperation[]>),
    put: async (op) => void (await run("readwrite", (s) => s.put(op))),
    remove: async (id) => void (await run("readwrite", (s) => s.delete(id))),
  };
}
