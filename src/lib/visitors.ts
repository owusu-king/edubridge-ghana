/** Visitors and pickup (R4-4): values and rules shared by the server, the pages and the tests. */

export const VISIT_PURPOSES = [
  "meeting",
  "family",
  "delivery",
  "contractor",
  "official",
  "interview",
  "other",
] as const;
export type VisitPurpose = (typeof VISIT_PURPOSES)[number];

export const VISIT_PURPOSE_LABELS: Record<VisitPurpose, string> = {
  meeting: "Meeting",
  family: "Parent or family",
  delivery: "Delivery",
  contractor: "Contractor or repairs",
  official: "Official visit",
  interview: "Interview",
  other: "Other",
};

export const PICKUP_OUTCOMES = ["released", "refused"] as const;
export type PickupOutcome = (typeof PICKUP_OUTCOMES)[number];

/** A named collector may collect the child: not ended, and not past their last day (VIS-02b). */
export function collectorAllowed(
  collector: { endedAt: Date | null; validUntil: string | null },
  today: string,
): boolean {
  return collector.endedAt === null && (collector.validUntil === null || collector.validUntil >= today);
}

/** Each student's latest record of the day that was not cancelled (VIS-02d). Records in any order. */
export function latestByStudent<T extends { studentId: string; recordedAt: Date; cancelledAt: Date | null }>(
  records: readonly T[],
): Map<string, T> {
  const latest = new Map<string, T>();
  for (const r of records) {
    if (r.cancelledAt) continue;
    const seen = latest.get(r.studentId);
    if (!seen || r.recordedAt > seen.recordedAt) latest.set(r.studentId, r);
  }
  return latest;
}
