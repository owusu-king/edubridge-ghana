"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { sendFeeReminders, type ReminderResult } from "@/server/fees/reminders";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";
import { dispatchAfterResponse } from "@/web/notify";
import { describeReminders } from "@/web/reminders";

export async function sendRemindersAction(slug: string, studentIds: string[]): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  let result: ReminderResult;
  try {
    result = await sendFeeReminders(db(), ctx, { studentIds });
  } catch (error) {
    return toFormError(error);
  }
  if (result.sent) dispatchAfterResponse();
  revalidatePath(schoolPath(slug, "fees/owing"));
  return { status: result.sent ? "success" : "error", message: describeReminders(result) };
}
