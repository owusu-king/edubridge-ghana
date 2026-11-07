import { describe, expect, it } from "vitest";
import type { OperationOutcome, SyncOperation } from "@/lib/sync/protocol";
import { clearAnswered, dismiss, enqueue, flush, listQueue, memoryStore } from "@/lib/sync/queue";

const who = { userId: "u1", school: "kpone" };
const base = { ...who, scope: "students:register", label: "A child", kind: "student.register" as const };

describe("the device sync queue", () => {
  it("sends pending changes oldest first and keeps answers that need a person", async () => {
    const store = memoryStore();
    const a = await enqueue(store, { ...base, payload: { n: 1 }, recordedAt: "2026-11-07T08:00:00.000Z" });
    const b = await enqueue(store, { ...base, payload: { n: 2 }, recordedAt: "2026-11-07T08:01:00.000Z" });
    const c = await enqueue(store, { ...base, payload: { n: 3 }, recordedAt: "2026-11-07T08:02:00.000Z" });
    // Another person's change on the same device is not sent with this person's.
    await enqueue(store, { ...base, userId: "u2", payload: {} });
    const sent: SyncOperation[] = [];
    const summary = await flush(store, who, async (ops) => {
      sent.push(...ops);
      return [
        { id: a.id, kind: a.kind, status: "applied", result: { admissionNumber: "A1" }, replayed: false },
        { id: b.id, kind: b.kind, status: "conflict", result: { possibleDuplicates: [] }, replayed: false },
        {
          id: c.id,
          kind: c.kind,
          status: "rejected",
          error: { code: "forbidden", message: "No" },
          replayed: false,
        },
      ] satisfies OperationOutcome[];
    });
    expect(sent.map((o) => o.id)).toEqual([a.id, b.id, c.id]);
    expect(sent[0]).toEqual({ id: a.id, kind: a.kind, payload: { n: 1 }, recordedAt: a.recordedAt });
    expect(summary.applied.map((o) => o.id)).toEqual([a.id]);
    const left = await listQueue(store, who);
    expect(left.map((o) => [o.id, o.state])).toEqual([
      [b.id, "conflict"],
      [c.id, "rejected"],
    ]);
    // Answered changes are not sent again.
    let calls = 0;
    await flush(store, who, async () => {
      calls++;
      return [];
    });
    expect(calls).toBe(0);
    await dismiss(store, b.id);
    expect((await listQueue(store, who)).map((o) => o.id)).toEqual([c.id]);
  });

  it("keeps everything when the server cannot be reached", async () => {
    const store = memoryStore();
    await enqueue(store, { ...base, payload: {} });
    const summary = await flush(store, who, async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(summary.offline).toBe(true);
    expect((await listQueue(store, who)).map((o) => o.state)).toEqual(["pending"]);
  });

  it("forgets answers on sign-out but keeps changes still to send", async () => {
    const store = memoryStore();
    const kept = await enqueue(store, { ...base, payload: {} });
    const answered = await enqueue(store, { ...base, payload: {} });
    await store.put({ ...answered, state: "conflict" });
    await clearAnswered(store);
    expect((await store.all()).map((o) => o.id)).toEqual([kept.id]);
  });

  it("filters by screen", async () => {
    const store = memoryStore();
    await enqueue(store, { ...base, payload: {} });
    await enqueue(store, { ...base, scope: "scores:t:c:s", kind: "assessment.scores", payload: {} });
    expect(await listQueue(store, who, "scores:t:c:s")).toHaveLength(1);
  });
});
