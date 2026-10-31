import { resolveFees, type StructureLine } from "./resolve";

/**
 * Works out which term charges to create, without touching the database. Billing is idempotent: each
 * student has at most one live charge per term and fee item (enforced by a unique billing key). Charges
 * already made are never changed; where they no longer match the structure (amount changed, student
 * moved class) they are reported as differences for the accountant to correct deliberately. To correct
 * one, reverse the charge and bill again: once every charge for an item is reversed, billing issues a
 * new one with a numbered key.
 */

export interface EnrolledStudent {
  studentId: string;
  classId: string;
  levelId: string;
}

export interface ExistingCharge {
  studentId: string;
  billingKey: string;
  /** Net amount after any reversal (0 when reversed). */
  netPesewas: number;
}

export interface PlannedCharge {
  studentId: string;
  feeItemId: string;
  amountPesewas: number;
  billingKey: string;
}

export interface BillingDifference {
  studentId: string;
  feeItemId: string;
  billedPesewas: number;
  structurePesewas: number;
}

export interface BillingPlan {
  toCreate: PlannedCharge[];
  differences: BillingDifference[];
  /** Students with every structure charge already billed. */
  billedStudents: number;
}

/** First charge: `term:<term>:item:<item>`; re-bills after reversals add `:2`, `:3`, … */
export const termBillingKey = (termId: string, feeItemId: string, attempt = 1) =>
  `term:${termId}:item:${feeItemId}${attempt > 1 ? `:${attempt}` : ""}`;

export function planBilling(
  termId: string,
  enrolled: readonly EnrolledStudent[],
  lines: readonly StructureLine[],
  itemOrder: readonly string[],
  existing: readonly ExistingCharge[],
): BillingPlan {
  const prefix = `term:${termId}:item:`;
  // Per student and item: the net billed so far and how many charges have been made.
  const billed = new Map<string, Map<string, { net: number; count: number }>>();
  for (const charge of existing) {
    if (!charge.billingKey.startsWith(prefix)) continue;
    const feeItemId = charge.billingKey.slice(prefix.length).split(":")[0]!;
    const byItem = billed.get(charge.studentId) ?? new Map<string, { net: number; count: number }>();
    const so = byItem.get(feeItemId) ?? { net: 0, count: 0 };
    byItem.set(feeItemId, { net: so.net + charge.netPesewas, count: so.count + 1 });
    billed.set(charge.studentId, byItem);
  }

  const toCreate: PlannedCharge[] = [];
  const differences: BillingDifference[] = [];
  let billedStudents = 0;
  for (const student of enrolled) {
    const fees = resolveFees(lines, student.levelId, student.classId, itemOrder);
    const already = billed.get(student.studentId) ?? new Map<string, { net: number; count: number }>();
    let missing = 0;
    for (const fee of fees) {
      const so = already.get(fee.feeItemId);
      if (!so || so.net === 0) {
        // Never billed, or every earlier charge was reversed.
        missing++;
        toCreate.push({
          studentId: student.studentId,
          feeItemId: fee.feeItemId,
          amountPesewas: fee.amountPesewas,
          billingKey: termBillingKey(termId, fee.feeItemId, (so?.count ?? 0) + 1),
        });
      } else if (so.net !== fee.amountPesewas) {
        differences.push({
          studentId: student.studentId,
          feeItemId: fee.feeItemId,
          billedPesewas: so.net,
          structurePesewas: fee.amountPesewas,
        });
      }
    }
    // Items billed earlier that the structure no longer charges this student.
    const current = new Set(fees.map((f) => f.feeItemId));
    for (const [feeItemId, so] of already) {
      if (!current.has(feeItemId) && so.net !== 0) {
        differences.push({
          studentId: student.studentId,
          feeItemId,
          billedPesewas: so.net,
          structurePesewas: 0,
        });
      }
    }
    if (fees.length > 0 && missing === 0) billedStudents++;
  }
  return { toCreate, differences, billedStudents };
}
