import { sumPesewas } from "@/lib/money";

/** One amount in a fee structure: for a level, or overriding it for one class. */
export interface StructureLine {
  feeItemId: string;
  levelId: string;
  classId: string | null;
  amountPesewas: number;
}

export interface ResolvedFee {
  feeItemId: string;
  amountPesewas: number;
}

/**
 * The fees charged to a student in a class, per fee item: the class's own amount where it has one,
 * otherwise the level's. Items with neither are not charged. Zero-amount lines are dropped (a class
 * override of zero exempts that class). Items keep the order given by `itemOrder`.
 */
export function resolveFees(
  lines: readonly StructureLine[],
  levelId: string,
  classId: string,
  itemOrder: readonly string[] = [],
): ResolvedFee[] {
  const chosen = new Map<string, number>();
  for (const line of lines) {
    if (line.levelId !== levelId || line.classId !== null) continue;
    chosen.set(line.feeItemId, line.amountPesewas);
  }
  for (const line of lines) {
    if (line.levelId !== levelId || line.classId !== classId) continue;
    chosen.set(line.feeItemId, line.amountPesewas);
  }
  const rank = (id: string) => {
    const i = itemOrder.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...chosen.entries()]
    .filter(([, amount]) => amount > 0)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([feeItemId, amountPesewas]) => ({ feeItemId, amountPesewas }));
}

export function totalFees(fees: readonly ResolvedFee[]): number {
  return sumPesewas(fees.map((f) => f.amountPesewas));
}
