"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { removeSchoolLogo, saveBrandColor, setSchoolLogo } from "@/server/tenancy/branding";
import { saveAdmissionFormat } from "@/server/tenancy/preferences";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

async function run(
  slug: string,
  fn: () => Promise<unknown>,
  message: string,
  formData?: FormData,
): Promise<FormState> {
  try {
    await fn();
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(schoolPath(slug), "layout");
  return { status: "success", message };
}

export async function saveBrandColorAction(slug: string, _prev: FormState, formData: FormData) {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () => saveBrandColor(db(), ctx, { brandColor: formData.get("brandColor") ?? "" }),
    "Colour saved.",
    formData,
  );
}

export async function uploadLogoAction(slug: string, _prev: FormState, formData: FormData) {
  const { ctx } = await requireTenant(slug);
  const file = formData.get("file");
  return run(
    slug,
    async () =>
      setSchoolLogo(db(), ctx, {
        filename: file instanceof File ? file.name : "",
        bytes: file instanceof File ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0),
      }),
    "Logo saved.",
  );
}

export async function removeLogoAction(slug: string, _prev: FormState) {
  const { ctx } = await requireTenant(slug);
  return run(slug, () => removeSchoolLogo(db(), ctx), "Logo removed.");
}

export async function saveAdmissionFormatAction(slug: string, _prev: FormState, formData: FormData) {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () =>
      saveAdmissionFormat(db(), ctx, {
        admissionPrefix: formData.get("admissionPrefix") ?? "",
        admissionDigits: formData.get("admissionDigits"),
      }),
    "Saved. New students get numbers in this format.",
    formData,
  );
}
