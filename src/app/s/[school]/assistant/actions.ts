"use server";

import { revalidatePath } from "next/cache";
import { askAssistant, type AssistantAnswer } from "@/server/assistant/service";
import { db } from "@/server/db/client";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

export async function askAssistantAction(
  slug: string,
  _prev: FormState<AssistantAnswer>,
  formData: FormData,
): Promise<FormState<AssistantAnswer>> {
  const { ctx } = await requireTenant(slug);
  try {
    const answer = await askAssistant(db(), ctx, { question: formData.get("question") });
    revalidatePath(schoolPath(slug, "assistant"));
    return { status: "success", data: answer, values: { question: String(formData.get("question") ?? "") } };
  } catch (error) {
    return toFormError(error, formData);
  }
}
