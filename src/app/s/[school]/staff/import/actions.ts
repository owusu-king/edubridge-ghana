"use server";

import { revalidatePath } from "next/cache";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { parseImportFile, type ParsedFile, type RowProblem } from "@/server/imports/files";
import {
  autoMapStaffColumns,
  checkStaffImport,
  importStaff,
  type StaffMapping,
} from "@/server/imports/staff";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";
import type { ActionResult, Checked, Mapping, Uploaded } from "@/components/imports/import-wizard";

/** Server actions for importing staff from a spreadsheet (2026-11-19). */

const failure = (error: unknown): { ok: false; message: string } => ({
  ok: false,
  message: toFormError(error).message ?? "Something went wrong.",
});

export async function uploadStaffAction(
  slug: string,
  _prev: FormState<Uploaded>,
  formData: FormData,
): Promise<FormState<Uploaded>> {
  const { ctx } = await requireTenant(slug);
  if (!allowed(ctx, "staff.manage"))
    return { status: "error", message: "You do not have permission to import staff." };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0)
    return {
      status: "error",
      message: "Choose a file to upload.",
      fieldErrors: { file: "Choose a file to upload." },
    };
  try {
    const parsed = await parseImportFile(
      { name: file.name, size: file.size, bytes: Buffer.from(await file.arrayBuffer()) },
      "staff",
    );
    return {
      status: "success",
      data: { ...parsed, fileName: file.name, mapping: autoMapStaffColumns(parsed.headers) },
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function checkStaffAction(
  slug: string,
  parsed: ParsedFile,
  mapping: Mapping,
): Promise<ActionResult<Checked>> {
  const { ctx } = await requireTenant(slug);
  try {
    const result = await checkStaffImport(db(), ctx, parsed, mapping as StaffMapping);
    const list = (names: string[]) => names.map((n) => `“${n}”`).join(", ");
    const notes = [
      ...(result.newPositions.length
        ? [`These positions will be added to your list: ${list(result.newPositions)}.`]
        : []),
      ...(result.newDepartments.length
        ? [`These departments will be added to your list: ${list(result.newDepartments)}.`]
        : []),
    ];
    return { ok: true, data: { total: result.total, valid: result.valid, problems: result.problems, notes } };
  } catch (error) {
    return failure(error);
  }
}

export async function importStaffAction(
  slug: string,
  parsed: ParsedFile,
  mapping: Mapping,
): Promise<ActionResult<{ imported: number; skipped: number; problems: RowProblem[] }>> {
  const { ctx } = await requireTenant(slug);
  try {
    const result = await importStaff(db(), ctx, parsed, mapping as StaffMapping);
    revalidatePath(schoolPath(slug, "staff"));
    return { ok: true, data: result };
  } catch (error) {
    return failure(error);
  }
}
