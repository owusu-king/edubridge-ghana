"use server";

import { revalidatePath } from "next/cache";
import { syncRegister } from "@/server/attendance/registers";
import { db } from "@/server/db/client";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { dispatchAfterResponse } from "@/web/notify";
import { toFormError } from "@/web/forms";
import type { SyncAnswer } from "@/components/attendance/offline";

/**
 * Saves register marks: from the register screen, or replayed from the device after being offline. Called as
 * a plain function (not a form), so expected failures come back as a message instead of throwing.
 */
export async function syncRegisterAction(slug: string, payload: unknown): Promise<SyncAnswer> {
  const { ctx } = await requireTenant(slug);
  try {
    const result = await syncRegister(db(), ctx, payload);
    if (result.alerts) dispatchAfterResponse();
    revalidatePath(schoolPath(slug, "attendance"), "layout");
    revalidatePath(schoolPath(slug, "assessment"), "layout");
    return { ok: true, result };
  } catch (error) {
    return { ok: false, message: toFormError(error).message ?? "This register could not be saved." };
  }
}
