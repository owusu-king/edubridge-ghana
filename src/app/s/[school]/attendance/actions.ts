"use server";

import { revalidatePath } from "next/cache";
import { syncAnyRegister } from "@/server/attendance/lessons";
import { db } from "@/server/db/client";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { dispatchAfterResponse } from "@/web/notify";
import { toFormError } from "@/web/forms";
import type { SyncAnswer } from "@/components/attendance/offline";

/**
 * Saves register marks (a class register, or a lesson register when the payload names a period): from the register screen, or replayed from the device after being offline. Called as
 * a plain function (not a form), so expected failures come back as a message instead of throwing.
 */
export async function syncRegisterAction(slug: string, payload: unknown): Promise<SyncAnswer> {
  const { ctx } = await requireTenant(slug);
  try {
    const result = await syncAnyRegister(db(), ctx, payload);
    if (result.alerts) dispatchAfterResponse();
    revalidatePath(schoolPath(slug, "attendance"), "layout");
    revalidatePath(schoolPath(slug, "assessment"), "layout");
    return { ok: true, result };
  } catch (error) {
    return { ok: false, message: toFormError(error).message ?? "This register could not be saved." };
  }
}
