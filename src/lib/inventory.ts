/** Inventory, assets and procurement (R4-6): values and rules shared by the server, the pages and the tests. */

export const MOVEMENT_KINDS = ["received", "issued", "counted"] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export const MOVEMENT_LABELS: Record<MovementKind, string> = {
  received: "Received",
  issued: "Issued",
  counted: "Count correction",
};

export const ASSET_CONDITIONS = ["new", "good", "fair", "poor", "broken"] as const;
export type AssetCondition = (typeof ASSET_CONDITIONS)[number];

export const CONDITION_LABELS: Record<AssetCondition, string> = {
  new: "New",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
  broken: "Broken",
};

export const ASSET_EVENT_KINDS = ["added", "moved", "custodian", "condition", "disposed"] as const;
export type AssetEventKind = (typeof ASSET_EVENT_KINDS)[number];

export const PURCHASE_STATUSES = ["pending", "approved", "declined", "cancelled", "received"] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = {
  pending: "Waiting for approval",
  approved: "Approved",
  declined: "Declined",
  cancelled: "Cancelled",
  received: "Received",
};

/** How each status reads in lists. */
export const PURCHASE_TONE: Record<PurchaseStatus, "neutral" | "caution" | "positive" | "critical"> = {
  pending: "caution",
  approved: "positive",
  declined: "critical",
  cancelled: "neutral",
  received: "neutral",
};

export const MAINTENANCE_PRIORITIES = ["low", "normal", "urgent"] as const;
export type MaintenancePriority = (typeof MAINTENANCE_PRIORITIES)[number];

export const PRIORITY_LABELS: Record<MaintenancePriority, string> = {
  low: "Low",
  normal: "Normal",
  urgent: "Urgent",
};

export const MAINTENANCE_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

export const MAINTENANCE_STATUS_LABELS: Record<MaintenanceStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
};

/** Where a maintenance request can go next: closed requests stay closed. */
export const MAINTENANCE_NEXT: Record<MaintenanceStatus, readonly MaintenanceStatus[]> = {
  open: ["in_progress", "done", "cancelled"],
  in_progress: ["done", "cancelled"],
  done: [],
  cancelled: [],
};

/** Movements change stock by a signed quantity: received adds, issued takes away, a count corrects either way. */
export function signedQuantity(kind: MovementKind, quantity: number): number {
  return kind === "issued" ? -Math.abs(quantity) : kind === "received" ? Math.abs(quantity) : quantity;
}

/** On hand: the sum of every movement (INV-01a). */
export function onHand(movements: readonly { quantity: number }[]): number {
  return movements.reduce((sum, m) => sum + m.quantity, 0);
}

export function isLow(item: { onHand: number; reorderLevel: number | null }): boolean {
  return item.reorderLevel !== null && item.onHand <= item.reorderLevel;
}

/** A line's estimated cost, and a request's total, in minor units (integers only). */
export function lineTotal(line: { quantity: number; unitPriceMinor: number | null }): number {
  return line.unitPriceMinor === null ? 0 : line.quantity * line.unitPriceMinor;
}

export function requestTotal(lines: readonly { quantity: number; unitPriceMinor: number | null }[]): number {
  return lines.reduce((sum, l) => sum + lineTotal(l), 0);
}

const pad = (n: number) => String(n).padStart(4, "0");
export const assetTag = (n: number) => `A${pad(n)}`;
export const purchaseReference = (n: number) => `PR${pad(n)}`;
export const maintenanceReference = (n: number) => `MR${pad(n)}`;
