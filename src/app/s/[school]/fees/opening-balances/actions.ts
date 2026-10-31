"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import {
  checkOpeningBalances,
  importOpeningBalances,
  type BalanceCheck,
} from "@/server/fees/opening-balances";
import { parseImportFile, type ParsedFile } from "@/server/imports/students";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

export interface CheckedFile {
  fileName: string;
  parsed: ParsedFile;
  check: BalanceCheck;
}

export async function checkBalancesAction(
  slug: string,
  _prev: FormState<CheckedFile>,
  formData: FormData,
): Promise<FormState<CheckedFile>> {
  const { ctx } = await requireTenant(slug);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return {
      status: "error",
      message: "Choose a file to upload.",
      fieldErrors: { file: "Choose a file to upload." },
    };
  }
  try {
    const parsed = await parseImportFile({
      name: file.name,
      size: file.size,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    const check = await checkOpeningBalances(db(), ctx, parsed);
    return { status: "success", data: { fileName: file.name, parsed, check } };
  } catch (error) {
    return toFormError(error);
  }
}

export type ImportResult = { ok: true; imported: number } | { ok: false; message: string };

export async function importBalancesAction(
  slug: string,
  parsed: ParsedFile,
  asOf: string,
): Promise<ImportResult> {
  const { ctx } = await requireTenant(slug);
  try {
    const result = await importOpeningBalances(db(), ctx, parsed, { asOf });
    revalidatePath(schoolPath(slug, "fees"), "layout");
    return { ok: true, imported: result.imported };
  } catch (error) {
    return { ok: false, message: toFormError(error).message ?? "Something went wrong." };
  }
}
