"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { billTerm } from "@/server/fees/ledger";
import {
  copyFeeStructure,
  createFeeItem,
  renameFeeItem,
  saveLevelFees,
  setFeeItemStatus,
  setupFeeItems,
  type LevelFeesInput,
} from "@/server/fees/structure";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

type Ctx = Awaited<ReturnType<typeof requireTenant>>["ctx"];

async function run(
  slug: string,
  formData: FormData | null,
  fn: (ctx: Ctx) => Promise<unknown>,
  message: string,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await fn(ctx);
  } catch (error) {
    return toFormError(error, formData ?? undefined);
  }
  revalidatePath(schoolPath(slug, "fees"), "layout");
  return { status: "success", message };
}

export async function setupFeeItemsAction(slug: string, _prev: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    (ctx) => setupFeeItems(db(), ctx, { names: formData.getAll("names").map(String) }),
    "Fee items added.",
  );
}

export async function addFeeItemAction(slug: string, _prev: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    (ctx) => createFeeItem(db(), ctx, { name: formData.get("name") }),
    "Fee item added.",
  );
}

export async function renameFeeItemAction(
  slug: string,
  itemId: string,
  _prev: FormState,
  formData: FormData,
) {
  return run(
    slug,
    formData,
    (ctx) => renameFeeItem(db(), ctx, itemId, { name: formData.get("name") }),
    "Fee item renamed.",
  );
}

export async function setFeeItemStatusAction(
  slug: string,
  itemId: string,
  status: "active" | "archived",
  _prev: FormState,
) {
  return run(
    slug,
    null,
    (ctx) => setFeeItemStatus(db(), ctx, itemId, status === "archived" ? "archived" : "active"),
    "Fee item updated.",
  );
}

/** Reads `amount:<item>` and `class:<class>:<item>` fields into the service's input shape. */
function levelFeesInput(formData: FormData): LevelFeesInput {
  const input: LevelFeesInput = { amounts: {}, classAmounts: {} };
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string") continue;
    const parts = key.split(":");
    if (parts[0] === "amount" && parts.length === 2) input.amounts[parts[1]!] = value;
    if (parts[0] === "class" && parts.length === 3) (input.classAmounts[parts[1]!] ??= {})[parts[2]!] = value;
  }
  return input;
}

export async function saveLevelFeesAction(
  slug: string,
  termId: string,
  levelId: string,
  _prev: FormState,
  formData: FormData,
) {
  return run(
    slug,
    formData,
    (ctx) => saveLevelFees(db(), ctx, termId, levelId, levelFeesInput(formData)),
    "Fees saved.",
  );
}

export async function copyFeeStructureAction(
  slug: string,
  toTermId: string,
  _prev: FormState,
  formData: FormData,
) {
  return run(
    slug,
    formData,
    (ctx) => copyFeeStructure(db(), ctx, { fromTermId: formData.get("fromTermId"), toTermId }),
    "Fees copied.",
  );
}

export async function billTermAction(slug: string, termId: string, _prev: FormState) {
  return run(slug, null, (ctx) => billTerm(db(), ctx, termId), "Students billed.");
}
