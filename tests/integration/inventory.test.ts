import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { exportDataset } from "@/server/export/datasets";
import {
  addAsset,
  changeAsset,
  disposeAsset,
  getAsset,
  listAssets,
  listCustodianOptions,
} from "@/server/inventory/assets";
import {
  getMaintenance,
  listMaintenance,
  reportMaintenance,
  updateMaintenance,
} from "@/server/inventory/maintenance";
import {
  cancelPurchaseRequest,
  createPurchaseRequest,
  decidePurchaseRequest,
  getPurchaseRequest,
  listPurchaseRequests,
  receivePurchaseRequest,
} from "@/server/inventory/purchases";
import { getStockItem, listStockItems, recordMovement, saveStockItem } from "@/server/inventory/stock";
import { saveSupplier } from "@/server/inventory/suppliers";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const raw = (s: School, statement: ReturnType<typeof sql>) =>
  withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) => tx.execute(statement));

const onHand = async (s: School, itemId: string) =>
  (await getStockItem(conn.app, s.bursar, itemId))!.item.onHand;

describe("stock (INV-01a, INV-01b)", () => {
  it("changes stock only by movements, never below zero, even when two people issue at once", async () => {
    const s = await school();
    const supplier = await saveSupplier(conn.app, s.bursar, {
      name: "Accra Stationers",
      phone: "024 455 5012",
    });
    const paper = await saveStockItem(conn.app, s.bursar, {
      name: "A4 paper",
      category: "Stationery",
      unit: "ream",
      reorderLevel: "5",
    });
    await expect(saveStockItem(conn.app, s.bursar, { name: "a4 paper", unit: "ream" })).rejects.toThrow(
      "already an item with this name",
    );
    await expect(saveStockItem(conn.app, s.teacher, { name: "Chalk", unit: "box" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    await recordMovement(conn.app, s.bursar, paper, {
      kind: "received",
      quantity: "10",
      unitCost: "45",
      supplierId: supplier,
    });
    await expect(
      recordMovement(conn.app, s.bursar, paper, { kind: "issued", quantity: "2" }),
    ).rejects.toThrow("Say who or where it went");
    await recordMovement(conn.app, s.bursar, paper, { kind: "issued", quantity: "3", issuedTo: "Basic 4A" });
    expect(await onHand(s, paper)).toBe(7);

    // Two issues of 6 at once from 7: one goes through, the other is refused.
    const results = await Promise.allSettled([
      recordMovement(conn.app, s.bursar, paper, { kind: "issued", quantity: "6", issuedTo: "Exams" }),
      recordMovement(conn.app, s.owner, paper, { kind: "issued", quantity: "6", issuedTo: "Office" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toContain(
      "Only 1 ream on hand",
    );
    expect(await onHand(s, paper)).toBe(1);
    expect((await listStockItems(conn.app, s.head))[0]).toMatchObject({ onHand: 1, low: true });

    // A count records the difference, with a reason.
    await expect(
      recordMovement(conn.app, s.bursar, paper, { kind: "counted", quantity: "3" }),
    ).rejects.toThrow("Say why the count differs");
    await recordMovement(conn.app, s.bursar, paper, {
      kind: "counted",
      quantity: "3",
      reason: "Box found in store",
    });
    const { movements } = (await getStockItem(conn.app, s.bursar, paper))!;
    expect(movements.map((m) => [m.kind, m.quantity])).toEqual([
      ["counted", 2],
      expect.arrayContaining(["issued"]),
      ["issued", -3],
      ["received", 10],
    ]);
    expect(movements.at(-1)).toMatchObject({ supplier: "Accra Stationers", unitCostMinor: 4500 });

    await expect(raw(s, sql`update stock_movements set quantity = 100`)).rejects.toThrow();
    await expect(raw(s, sql`delete from stock_movements`)).rejects.toThrow();
    await expect(raw(s, sql`delete from stock_items`)).rejects.toThrow();
    const file = await exportDataset(conn.app, s.owner, "stock");
    expect(file.rows).toBe(movements.length);
  });
});

describe("assets (INV-01c)", () => {
  it("tags assets from a counter, keeps every move as history, and disposes of them once", async () => {
    const s = await school();
    const custodians = await listCustodianOptions(conn.app, s.owner);
    const head = custodians.find((c) => c.name === "Head")!.id;
    const first = await addAsset(conn.app, s.owner, {
      name: "Epson projector",
      category: "ICT",
      location: "ICT lab",
      condition: "good",
      cost: "3500",
    });
    const second = await addAsset(conn.app, s.bursar, { name: "Office desk", condition: "new" });
    expect([first.tag, second.tag]).toEqual(["A0001", "A0002"]);

    await changeAsset(conn.app, s.owner, first.id, {
      location: "Staff room",
      custodianMembershipId: head,
      condition: "fair",
      note: "Moved for the staff meeting.",
    });
    await expect(
      changeAsset(conn.app, s.owner, first.id, {
        location: "Staff room",
        custodianMembershipId: head,
        condition: "fair",
      }),
    ).rejects.toThrow("Nothing has changed.");
    const { asset, events } = (await getAsset(conn.app, s.head, first.id))!;
    expect(asset).toMatchObject({
      location: "Staff room",
      custodian: "Head",
      condition: "fair",
      costMinor: 350000,
    });
    expect(events.map((e) => [e.kind, e.detail]).reverse()).toEqual([
      ["added", "at ICT lab, good"],
      ["moved", "ICT lab → Staff room"],
      ["custodian", "nobody → Head"],
      ["condition", "Good → Fair"],
    ]);

    await expect(disposeAsset(conn.app, s.owner, second.id, "")).rejects.toThrow("Say why");
    await disposeAsset(conn.app, s.owner, second.id, "Beyond repair");
    await expect(changeAsset(conn.app, s.owner, second.id, { condition: "good" })).rejects.toThrow(
      "disposed of",
    );
    // A disposed asset never changes, and none is deleted, in the database too.
    await expect(raw(s, sql`update assets set location = 'Store' where tag = 'A0002'`)).rejects.toThrow();
    await expect(raw(s, sql`delete from assets where tag = 'A0001'`)).rejects.toThrow();
    await expect(raw(s, sql`update assets set tag = 'A0009' where tag = 'A0001'`)).rejects.toThrow();
    await expect(raw(s, sql`delete from asset_events`)).rejects.toThrow();
    expect((await listAssets(conn.app, s.bursar)).map((a) => [a.tag, a.status])).toEqual([
      ["A0001", "active"],
      ["A0002", "disposed"],
    ]);
    const other = await school();
    expect(await listAssets(conn.app, other.owner)).toEqual([]);
  });
});

describe("purchase requests (INV-02b)", () => {
  it("is decided once by the Proprietor, never on their own request, and receiving adds to stock", async () => {
    const s = await school();
    const paper = await saveStockItem(conn.app, s.bursar, { name: "A4 paper", unit: "ream" });
    const { id, reference } = await createPurchaseRequest(conn.app, s.bursar, {
      title: "Paper for end-of-term exams",
      description_0: "A4 paper",
      quantity_0: "20",
      price_0: "45.50",
      stockItemId_0: paper,
      description_2: "Staples",
      quantity_2: "3",
    });
    expect(reference).toBe("PR0001");
    await expect(createPurchaseRequest(conn.app, s.bursar, { title: "Nothing to buy" })).rejects.toThrow(
      "Add at least one thing to buy.",
    );
    expect((await getPurchaseRequest(conn.app, s.owner, id))!).toMatchObject({
      status: "pending",
      totalMinor: 91000,
    });

    // Only the Proprietor decides; a decline needs a reason; receiving waits for approval.
    await expect(decidePurchaseRequest(conn.app, s.bursar, id, { approve: true })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(decidePurchaseRequest(conn.app, s.owner, id, { approve: false })).rejects.toThrow(
      "Say why it is declined.",
    );
    await expect(receivePurchaseRequest(conn.app, s.bursar, id, {})).rejects.toThrow(
      "Only an approved request",
    );
    await decidePurchaseRequest(conn.app, s.owner, id, { approve: true });
    await expect(
      decidePurchaseRequest(conn.app, s.owner, id, { approve: false, note: "Changed my mind" }),
    ).rejects.toThrow("already been dealt with");

    const detail = (await getPurchaseRequest(conn.app, s.bursar, id))!;
    await receivePurchaseRequest(conn.app, s.bursar, id, {
      [`received_${detail.lines[0]!.id}`]: "18",
      [`received_${detail.lines[1]!.id}`]: "3",
      note: "Two reams short",
    });
    expect(await onHand(s, paper)).toBe(18);
    expect((await getPurchaseRequest(conn.app, s.bursar, id))!).toMatchObject({
      status: "received",
      lines: [
        expect.objectContaining({ receivedQuantity: 18 }),
        expect.objectContaining({ receivedQuantity: 3 }),
      ],
    });
    await expect(receivePurchaseRequest(conn.app, s.bursar, id, {})).rejects.toThrow(
      "Only an approved request",
    );

    // The Proprietor's own request needs someone else; the database refuses it too.
    const own = await createPurchaseRequest(conn.app, s.owner, {
      title: "New printer",
      description_0: "Printer",
      quantity_0: "1",
    });
    await expect(decidePurchaseRequest(conn.app, s.owner, own.id, { approve: true })).rejects.toThrow(
      "Someone else must decide",
    );
    await expect(
      raw(
        s,
        sql`update purchase_requests set status = 'approved', decided_by_user_id = requested_by_user_id, decided_at = now() where id = ${own.id}`,
      ),
    ).rejects.toThrow();
    // The person asking cancels while it waits; nothing moves backwards or is deleted.
    await cancelPurchaseRequest(conn.app, s.owner, own.id, "Borrowed one instead");
    await expect(
      raw(s, sql`update purchase_requests set status = 'pending' where id = ${own.id}`),
    ).rejects.toThrow();
    await expect(raw(s, sql`delete from purchase_request_lines`)).rejects.toThrow();
    expect((await listPurchaseRequests(conn.app, s.head)).map((r) => [r.reference, r.status])).toEqual([
      ["PR0002", "cancelled"],
      ["PR0001", "received"],
    ]);
    expect((await exportDataset(conn.app, s.owner, "purchases")).rows).toBe(3);
  });
});

describe("maintenance (INV-02c)", () => {
  it("lets any member report, the office move it on, and keeps closed requests closed", async () => {
    const s = await school();
    const { id, reference } = await reportMaintenance(conn.app, s.teacher, {
      title: "Ceiling fan not working",
      location: "Basic 4A",
      priority: "urgent",
    });
    expect(reference).toBe("MR0001");
    await reportMaintenance(conn.app, s.bursar, { title: "Leaking tap in the staff room", priority: "low" });
    // Teachers see their own; the office sees all.
    expect((await listMaintenance(conn.app, s.teacher)).map((r) => r.reference)).toEqual(["MR0001"]);
    expect(await listMaintenance(conn.app, s.head)).toHaveLength(2);
    expect(
      await getMaintenance(conn.app, s.teacher, (await listMaintenance(conn.app, s.head))[1]!.id),
    ).toBeNull();

    await expect(
      updateMaintenance(conn.app, s.teacher, id, { status: "in_progress" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await updateMaintenance(conn.app, s.head, id, {
      status: "in_progress",
      assignedTo: "Kofi the electrician",
    });
    await expect(updateMaintenance(conn.app, s.head, id, { status: "open" })).rejects.toThrow(
      "cannot go back",
    );
    await expect(
      updateMaintenance(conn.app, s.head, id, { status: "done", assignedTo: "Kofi the electrician" }),
    ).rejects.toThrow("Say what was done.");
    await updateMaintenance(conn.app, s.head, id, {
      status: "done",
      assignedTo: "Kofi the electrician",
      note: "Replaced the capacitor.",
    });
    await expect(updateMaintenance(conn.app, s.head, id, { status: "cancelled" })).rejects.toThrow("closed");
    const detail = (await getMaintenance(conn.app, s.teacher, id))!;
    expect(detail.updates.map((u) => [u.status, u.note])).toEqual([
      ["done", "Replaced the capacitor."],
      ["in_progress", null],
    ]);
    await expect(
      raw(s, sql`update maintenance_requests set status = 'open' where id = ${id}`),
    ).rejects.toThrow();
    await expect(raw(s, sql`delete from maintenance_updates`)).rejects.toThrow();
    expect((await exportDataset(conn.app, s.owner, "maintenance")).rows).toBe(2);
  });
});
