"use server";

import { revalidatePath } from "next/cache";
import { removeAiApiKey, setAiApiKey, updateAiLimits, updateAiSettings } from "@/server/ai/admin";
import { db } from "@/server/db/client";
import { rotateSigningKey } from "@/server/platform/integrations";
import { AI_LIMIT_RANGES, AI_TASKS, type AiProviderId } from "@/lib/ai-providers";
import { requirePlatformAdmin } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

const PATH = "/admin/integrations";

/** The AI gateway's switch, features, provider and model (R5-4). */
export async function saveAiSettingsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await updateAiSettings(db(), user.id, {
      enabled: formData.get("enabled") === "on",
      provider: formData.get("provider"),
      model: formData.get("model") ?? "",
      baseUrl: formData.get("baseUrl") ?? "",
      identifiableApproved: formData.get("identifiableApproved") === "on",
      tasks: Object.fromEntries(AI_TASKS.map((t) => [t, formData.get(`task.${t}`) === "on"])),
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(PATH);
  return { status: "success", message: "AI settings saved." };
}

export async function saveAiLimitsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await updateAiLimits(
      db(),
      user.id,
      Object.fromEntries(Object.keys(AI_LIMIT_RANGES).map((k) => [k, formData.get(k)])),
    );
  } catch (error) {
    return toFormError(error, formData);
  }
  revalidatePath(PATH);
  return { status: "success", message: "AI limits saved." };
}

export async function saveAiKeyAction(
  provider: AiProviderId,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await setAiApiKey(db(), user.id, { provider, apiKey: formData.get("apiKey") });
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(PATH);
  return { status: "success", message: "API key saved. It is stored encrypted and is not shown again." };
}

export async function removeAiKeyAction(provider: AiProviderId, _prev: FormState): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    await removeAiApiKey(db(), user.id, provider);
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath(PATH);
  return { status: "success", message: "API key removed." };
}

export async function rotateSigningKeyAction(_prev: FormState): Promise<FormState> {
  const user = await requirePlatformAdmin();
  try {
    const keyId = await rotateSigningKey(db(), user.id);
    revalidatePath(PATH);
    return {
      status: "success",
      message: `New signing key ${keyId} is active. Earlier records still verify.`,
    };
  } catch (error) {
    return toFormError(error);
  }
}
