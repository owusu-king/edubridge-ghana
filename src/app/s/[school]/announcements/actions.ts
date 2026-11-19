"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { resolveDraft } from "@/server/drafting/service";
import { cancelScheduledAnnouncement, postAnnouncement } from "@/server/messages/announcements";
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
      sendAt: formData.get("when") === "later" ? formData.get("sendAt") : undefined,
    });
    // A drafted announcement: posted as drafted, or changed first (R5-5, DRF-04).
    await resolveDraft(
      db(),
      ctx,
      String(formData.get("draftId") ?? ""),
      `${String(formData.get("title") ?? "").trim()}\n\n${String(formData.get("body") ?? "").trim()}`,
    );
    if (posted.sms) dispatchAfterResponse();
    revalidatePath(schoolPath(slug, "announcements"));
    if (posted.scheduledFor)
      return {
        status: "success",
        message: "Announcement scheduled. Nothing is sent until then, and you can cancel it until it goes.",
      };
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

export async function cancelScheduledAction(slug: string, id: string, _prev: FormState): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await cancelScheduledAnnouncement(db(), ctx, id);
    revalidatePath(schoolPath(slug, "announcements"));
    return { status: "success", message: "Scheduled announcement cancelled." };
  } catch (error) {
    return toFormError(error);
  }
}
