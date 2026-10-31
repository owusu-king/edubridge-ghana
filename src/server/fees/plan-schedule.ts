/**
 * Payment plan arithmetic, free of the database: splitting an amount into instalments and measuring
 * payments against them. Amounts are integer pesewas; dates are ISO calendar dates (YYYY-MM-DD).
 */

export const FREQUENCIES = ["monthly", "fortnightly", "weekly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface Instalment {
  sequence: number;
  dueOn: string;
  amountPesewas: number;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Same day next month, or the month's last day when it is shorter (31 Jan → 28 Feb). */
function addMonths(iso: string, months: number): string {
  const [y, m, day] = iso.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Equal instalments; the last one takes any pesewas left over so the total is exact. */
export function splitInstalments(
  totalPesewas: number,
  count: number,
  firstDueOn: string,
  frequency: Frequency,
): Instalment[] {
  if (!Number.isSafeInteger(totalPesewas) || totalPesewas < count)
    throw new RangeError("Total too small to split.");
  if (!Number.isInteger(count) || count < 2 || count > 12) throw new RangeError("Use 2 to 12 instalments.");
  const share = Math.floor(totalPesewas / count);
  return Array.from({ length: count }, (_, i) => ({
    sequence: i + 1,
    dueOn:
      frequency === "monthly"
        ? addMonths(firstDueOn, i)
        : addDays(firstDueOn, i * (frequency === "fortnightly" ? 14 : 7)),
    amountPesewas: i === count - 1 ? totalPesewas - share * (count - 1) : share,
  }));
}

export type InstalmentStatus = "paid" | "partly_paid" | "overdue" | "upcoming";

export interface InstalmentProgress extends Instalment {
  paidPesewas: number;
  status: InstalmentStatus;
}

export interface PlanProgress {
  instalments: InstalmentProgress[];
  paidPesewas: number;
  remainingPesewas: number;
  /** Unpaid amounts of instalments whose due date has passed. */
  overduePesewas: number;
  nextDue: InstalmentProgress | null;
}

/** Applies payments to instalments in due order. Payments beyond the plan total are not counted. */
export function planProgress(
  instalments: readonly Instalment[],
  paidPesewas: number,
  today: string,
): PlanProgress {
  let left = Math.max(0, paidPesewas);
  const rows = [...instalments]
    .sort((a, b) => a.sequence - b.sequence)
    .map((inst): InstalmentProgress => {
      const paid = Math.min(left, inst.amountPesewas);
      left -= paid;
      const status: InstalmentStatus =
        paid === inst.amountPesewas
          ? "paid"
          : inst.dueOn < today
            ? "overdue"
            : paid > 0
              ? "partly_paid"
              : "upcoming";
      return { ...inst, paidPesewas: paid, status };
    });
  const total = rows.reduce((sum, r) => sum + r.amountPesewas, 0);
  const paid = rows.reduce((sum, r) => sum + r.paidPesewas, 0);
  return {
    instalments: rows,
    paidPesewas: paid,
    remainingPesewas: total - paid,
    overduePesewas: rows
      .filter((r) => r.status === "overdue")
      .reduce((s, r) => s + r.amountPesewas - r.paidPesewas, 0),
    nextDue: rows.find((r) => r.status !== "paid") ?? null,
  };
}
