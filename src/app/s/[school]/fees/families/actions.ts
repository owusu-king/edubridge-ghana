"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { applySiblingDiscounts, saveSiblingRule } from "@/server/fees/siblings";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

export async function saveSiblingRuleAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await saveSiblingRule(db(), ctx, {
      firstChild: formData.get("firstChild"),
      secondPercent: formData.get("secondPercent"),
      laterPercent: formData.get("laterPercent"),
      feeItemId: formData.get("feeItemId"),
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug, "fees/families"));
  return { status: "success", message: "Rule saved. Apply it to update each child's discount." };
}

export async function applySiblingDiscountsAction(slug: string): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const r = await applySiblingDiscounts(db(), ctx);
    revalidatePath(schoolPath(slug, "fees"), "layout");
    revalidatePath(schoolPath(slug, "students"), "layout");
    return {
      status: "success",
      message: `Sibling discounts: ${r.added} added, ${r.replaced} changed, ${r.ended} ended. They apply to charges when the term is next billed.`,
    };
  } catch (error) {
    return toFormError(error);
  }
}
