"use server";

import { revalidatePath } from "next/cache";
import { can } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import {
  autoMapColumns,
  checkStudentImport,
  importStudents,
  parseImportFile,
  type ColumnMapping,
  type ImportCheck,
  type ParsedFile,
  type RowProblem,
} from "@/server/imports/students";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

export interface Uploaded extends ParsedFile {
  fileName: string;
  mapping: ColumnMapping;
}

export async function uploadAction(
  slug: string,
  _prev: FormState<Uploaded>,
  formData: FormData,
): Promise<FormState<Uploaded>> {
  const { ctx } = await requireTenant(slug);
  if (!can(ctx.roles, "students.manage")) {
    return { status: "error", message: "You do not have permission to import students." };
  }
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
    return {
      status: "success",
      data: { ...parsed, fileName: file.name, mapping: autoMapColumns(parsed.headers) },
    };
  } catch (error) {
    return toFormError(error);
  }
}

export type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string };

function failure(error: unknown): { ok: false; message: string } {
  const state = toFormError(error);
  return { ok: false, message: state.message ?? "Something went wrong." };
}

export async function checkAction(
  slug: string,
  parsed: ParsedFile,
  mapping: ColumnMapping,
): Promise<ActionResult<ImportCheck>> {
  const { ctx } = await requireTenant(slug);
  try {
    return { ok: true, data: await checkStudentImport(db(), ctx, parsed, mapping) };
  } catch (error) {
    return failure(error);
  }
}

export async function importAction(
  slug: string,
  parsed: ParsedFile,
  mapping: ColumnMapping,
): Promise<ActionResult<{ imported: number; skipped: number; problems: RowProblem[] }>> {
  const { ctx } = await requireTenant(slug);
  try {
    const result = await importStudents(db(), ctx, parsed, mapping);
    revalidatePath(schoolPath(slug, "students"));
    return { ok: true, data: result };
  } catch (error) {
    return failure(error);
  }
}
