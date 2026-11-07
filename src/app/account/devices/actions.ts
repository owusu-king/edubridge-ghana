"use server";

import { revalidatePath } from "next/cache";
import { revokeDeviceToken } from "@/server/auth/device-tokens";
import { db } from "@/server/db/client";
import { requireUser } from "@/web/auth";
import type { FormState } from "@/web/forms";

export async function revokeDeviceAction(handle: string, _prev: FormState): Promise<FormState> {
  const user = await requireUser();
  const revoked = await revokeDeviceToken(db(), user.id, handle);
  revalidatePath("/account/devices");
  return revoked
    ? { status: "success", message: "Device signed out." }
    : { status: "error", message: "That device was already signed out." };
}
