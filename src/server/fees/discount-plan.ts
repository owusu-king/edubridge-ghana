/**
 * Works out the discount entries a billing run should add, without touching the database. Each
 * concession gives at most one discount per student, term and fee item (its billing key), computed on
 * the live charge for that item. Several concessions on one item never discount more than the charge.
 */

export interface ConcessionRule {
  id: string;
  studentId: string;
  /** Null: every fee item. */
  feeItemId: string | null;
  percentBasisPoints: number | null;
  amountPesewas: number | null;
}

export interface ChargeBase {
  studentId: string;
  feeItemId: string;
  /** The live charge for this item this term (after reversals). */
  amountPesewas: number;
}

export interface ExistingDiscount {
  studentId: string;
  billingKey: string;
  /** Negative, or 0 when reversed. */
  netPesewas: number;
}

export interface PlannedDiscount {
  studentId: string;
  feeItemId: string;
  concessionId: string;
  /** Negative: reduces what is owed. */
  amountPesewas: number;
  billingKey: string;
}

export const discountBillingKey = (concessionId: string, termId: string, feeItemId: string) =>
  `discount:${concessionId}:term:${termId}:item:${feeItemId}`;

/** A percentage of an amount in whole pesewas, rounded half up, using integer arithmetic only. */
export function percentOf(amountPesewas: number, basisPoints: number): number {
  return Math.floor((amountPesewas * basisPoints + 5000) / 10000);
}

export function planDiscounts(
  termId: string,
  bases: readonly ChargeBase[],
  concessions: readonly ConcessionRule[],
  existing: readonly ExistingDiscount[],
): PlannedDiscount[] {
  const termMarker = `:term:${termId}:item:`;
  const usedKeys = new Set(existing.map((d) => d.billingKey));
  // Already discounted per student and item this term, from any concession.
  const discounted = new Map<string, number>();
  for (const d of existing) {
    const at = d.billingKey.indexOf(termMarker);
    if (!d.billingKey.startsWith("discount:") || at === -1) continue;
    const key = `${d.studentId}|${d.billingKey.slice(at + termMarker.length)}`;
    discounted.set(key, (discounted.get(key) ?? 0) - d.netPesewas);
  }
  const planned: PlannedDiscount[] = [];
  for (const base of bases) {
    if (base.amountPesewas <= 0) continue;
    let remaining = base.amountPesewas - (discounted.get(`${base.studentId}|${base.feeItemId}`) ?? 0);
    for (const c of concessions) {
      if (remaining <= 0) break;
      if (c.studentId !== base.studentId) continue;
      if (c.feeItemId !== null && c.feeItemId !== base.feeItemId) continue;
      const billingKey = discountBillingKey(c.id, termId, base.feeItemId);
      if (usedKeys.has(billingKey)) continue;
      const raw =
        c.percentBasisPoints !== null
          ? percentOf(base.amountPesewas, c.percentBasisPoints)
          : Math.min(c.amountPesewas ?? 0, base.amountPesewas);
      const amount = Math.min(raw, remaining);
      if (amount <= 0) continue;
      remaining -= amount;
      planned.push({
        studentId: base.studentId,
        feeItemId: base.feeItemId,
        concessionId: c.id,
        amountPesewas: -amount,
        billingKey,
      });
    }
  }
  return planned;
}
