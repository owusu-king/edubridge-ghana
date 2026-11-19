import "server-only";
import type { Queryable } from "../db/client";
import type { TenantContext } from "../tenancy/service";
import { readBoarders } from "./boarders";
import { readBoardingFeeItem } from "./houses";

/**
 * The boarding fee item while Boarding decides who takes it (BRD-02): billing charges it, at the fee structure's
 * amount for the student's level or class, to students with a bed that term, and to nobody else. Null when the
 * module is not active or no item is chosen: then the item is billed like any optional item.
 */
export async function boardingFeeItemId(
  tx: Queryable,
  ctx: Pick<TenantContext, "tenant" | "features">,
): Promise<string | null> {
  if (!ctx.features.includes("boarding")) return null;
  return readBoardingFeeItem(tx, ctx.tenant.id);
}

/** The boarding item and who takes it in a term, for term billing. */
export async function readBoardingCharges(
  tx: Queryable,
  ctx: Pick<TenantContext, "tenant" | "features">,
  termId: string,
): Promise<{ feeItemId: string; boarders: Set<string> } | null> {
  const feeItemId = await boardingFeeItemId(tx, ctx);
  return feeItemId ? { feeItemId, boarders: await readBoarders(tx, ctx.tenant.id, termId) } : null;
}
