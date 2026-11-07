"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { SYNC_HANDLERS } from "@/server/sync/handlers";
import { applyOperations } from "@/server/sync/protocol";
import type { OperationOutcome, SyncOperation } from "@/lib/sync/protocol";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError } from "@/web/forms";

export type SyncAnswer = { ok: true; outcomes: OperationOutcome[] } | { ok: false; message: string };

/** The web's way into the sync protocol (devices use POST /api/v1/schools/{school}/sync). */
export async function syncOperationsAction(slug: string, operations: SyncOperation[]): Promise<SyncAnswer> {
  const { ctx } = await requireTenant(slug);
  try {
    const outcomes = await applyOperations(db(), ctx, { operations }, SYNC_HANDLERS);
    if (outcomes.some((o) => o.status === "applied" && !o.replayed))
      revalidatePath(schoolPath(slug), "layout");
    return { ok: true, outcomes };
  } catch (error) {
    return { ok: false, message: toFormError(error).message ?? "These changes could not be sent." };
  }
}
