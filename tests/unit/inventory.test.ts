import { describe, expect, it } from "vitest";
import { allowed, PERMISSION_MODULES, type Access } from "@/server/authz/permissions";
import { MODULES } from "@/lib/modules";
import {
  assetTag,
  isLow,
  lineTotal,
  MAINTENANCE_NEXT,
  maintenanceReference,
  onHand,
  purchaseReference,
  requestTotal,
  signedQuantity,
} from "@/lib/inventory";

describe("inventory rules (INV)", () => {
  it("keeps stock as the sum of signed movements, and lists low items (INV-01a, INV-01b)", () => {
    expect(signedQuantity("received", 24)).toBe(24);
    expect(signedQuantity("issued", 5)).toBe(-5);
    expect(signedQuantity("counted", -2)).toBe(-2);
    expect(onHand([{ quantity: 24 }, { quantity: -5 }, { quantity: -2 }])).toBe(17);
    expect(isLow({ onHand: 10, reorderLevel: 10 })).toBe(true);
    expect(isLow({ onHand: 11, reorderLevel: 10 })).toBe(false);
    expect(isLow({ onHand: 0, reorderLevel: null })).toBe(false);
  });

  it("totals purchase requests in whole minor units, leaving lines without a price at zero (INV-02b)", () => {
    expect(lineTotal({ quantity: 3, unitPriceMinor: 4550 })).toBe(13650);
    expect(lineTotal({ quantity: 3, unitPriceMinor: null })).toBe(0);
    expect(
      requestTotal([
        { quantity: 10, unitPriceMinor: 4500 },
        { quantity: 2, unitPriceMinor: null },
        { quantity: 1, unitPriceMinor: 99 },
      ]),
    ).toBe(45099);
  });

  it("numbers tags and references, and keeps closed repairs closed (INV-01c, INV-02c)", () => {
    expect(assetTag(1)).toBe("A0001");
    expect(purchaseReference(42)).toBe("PR0042");
    expect(maintenanceReference(12345)).toBe("MR12345");
    expect(MAINTENANCE_NEXT.in_progress).not.toContain("open");
    expect(MAINTENANCE_NEXT.done).toEqual([]);
    expect(MAINTENANCE_NEXT.cancelled).toEqual([]);
  });

  it("gives the office and Accountant stock, the Proprietor approval, and every member repairs (INV-03)", () => {
    const access = (role: Access["roles"][number]): Access => ({
      roles: [role],
      features: ["inventory_assets"],
    });
    expect(allowed(access("bursar"), "inventory.manage")).toBe(true);
    expect(allowed(access("headteacher"), "inventory.manage")).toBe(false);
    expect(allowed(access("headteacher"), "maintenance.manage")).toBe(true);
    expect(allowed(access("bursar"), "purchases.approve")).toBe(false);
    expect(allowed(access("owner"), "purchases.approve")).toBe(true);
    expect(allowed(access("teacher"), "maintenance.report")).toBe(true);
    expect(allowed(access("teacher"), "inventory.view")).toBe(false);
    expect(allowed({ roles: ["owner"], features: [] }, "inventory.view")).toBe(false);
    for (const p of [
      "inventory.view",
      "inventory.manage",
      "purchases.request",
      "purchases.approve",
      "maintenance.report",
      "maintenance.manage",
    ] as const)
      expect(PERMISSION_MODULES[p]).toBe("inventory_assets");
    expect(MODULES.inventory_assets.routes).toEqual(["inventory"]);
  });
});
