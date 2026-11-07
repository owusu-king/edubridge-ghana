"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { postAnnouncement } from "@/server/messages/announcements";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";
import { dispatchAfterResponse } from "@/web/notify";

export async function postAnnouncementAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  // The audience select carries "kind:id" ("school:" for the whole school).
  const [audience, audienceId] = String(formData.get("audience") ?? "").split(":");
  try {
    const posted = await postAnnouncement(db(), ctx, {
      title: formData.get("title"),
      body: formData.get("body"),
      audience,
      audienceId: audienceId || null,
      sms: formData.get("sms") === "on",
    });
    if (posted.sms) dispatchAfterResponse();
    revalidatePath(schoolPath(slug, "announcements"));
    return {
      status: "success",
      message: posted.sms
        ? `Announcement posted and sent by SMS to ${posted.sms} ${posted.sms === 1 ? "family" : "families"}.`
        : "Announcement posted. Families see it in the parent view.",
    };
  } catch (error) {
    return toFormError(error, formData);
  }
}
