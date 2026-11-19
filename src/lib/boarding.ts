/** Boarding (R4-8): values and rules shared by the server, the pages and the tests. */

export const HOUSE_KINDS = ["boys", "girls", "mixed"] as const;
export type HouseKind = (typeof HOUSE_KINDS)[number];

export const HOUSE_KIND_LABELS: Record<HouseKind, string> = {
  boys: "Boys",
  girls: "Girls",
  mixed: "Mixed",
};

/** Whether a student may be placed in a house (BRD-01c). A student whose sex is not recorded fits a mixed house only. */
export function fitsHouse(kind: HouseKind, sex: "female" | "male" | null): boolean {
  if (kind === "mixed") return true;
  return (kind === "boys" && sex === "male") || (kind === "girls" && sex === "female");
}

/** Days an exeat is overdue on a day (0 when not overdue or already back). */
export function exeatOverdueDays(expectedBackOn: string, on: string, backAt: Date | null): number {
  if (backAt) return 0;
  const days = Math.round(
    (Date.parse(`${on}T00:00:00Z`) - Date.parse(`${expectedBackOn}T00:00:00Z`)) / 86_400_000,
  );
  return Math.max(0, days);
}
