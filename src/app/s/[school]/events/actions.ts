"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import {
  cancelConsentForm,
  changeConsentDeadline,
  createConsentForm,
  recordPaperAnswer,
  remindConsentForm,
} from "@/server/events/consent";
import { cancelEvent, createEvent, updateEvent } from "@/server/events/events";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";
import { dispatchAfterResponse } from "@/web/notify";

/** The audience select carries "kind:id" ("school:" for the whole school). */
function audienceOf(formData: FormData) {
  const [audience, audienceId] = String(formData.get("audience") ?? "").split(":");
  return { audience, audienceId: audienceId || null };
}

function eventInput(formData: FormData) {
  return {
    title: formData.get("title"),
    details: formData.get("details"),
    location: formData.get("location"),
    startsOn: formData.get("startsOn"),
    endsOn: formData.get("endsOn"),
    startTime: formData.get("startTime"),
    endTime: formData.get("endTime"),
    ...audienceOf(formData),
    reminder: formData.get("reminder") ?? "none",
    reminderDaysBefore: formData.get("reminderDaysBefore") ?? 1,
  };
}

const refresh = (slug: string) => revalidatePath(schoolPath(slug, "events"), "layout");

export async function createEventAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await createEvent(db(), ctx, eventInput(formData));
    refresh(slug);
    return { status: "success", message: "Event added. Families see it in the parent view." };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function updateEventAction(
  slug: string,
  id: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await updateEvent(db(), ctx, id, eventInput(formData));
    refresh(slug);
    return { status: "success", message: "Event saved." };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function cancelEventAction(slug: string, id: string, _prev: FormState): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const { forms } = await cancelEvent(db(), ctx, id);
    refresh(slug);
    return {
      status: "success",
      message: forms
        ? `Event cancelled, with ${forms} consent ${forms === 1 ? "form" : "forms"}.`
        : "Event cancelled. Families see that it is cancelled.",
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function createConsentFormAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  let id: string;
  try {
    const created = await createConsentForm(db(), ctx, {
      title: formData.get("title"),
      body: formData.get("body"),
      deadline: formData.get("deadline"),
      eventId: formData.get("eventId"),
      ...audienceOf(formData),
      sms: formData.get("sms") === "on",
    });
    if (created.sms || created.push) dispatchAfterResponse();
    id = created.id;
  } catch (error) {
    return toFormError(error, formData);
  }
  refresh(slug);
  redirect(schoolPath(slug, `events/forms/${id}`) as Route);
}

export async function changeDeadlineAction(
  slug: string,
  id: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await changeConsentDeadline(db(), ctx, id, { deadline: formData.get("deadline") });
    refresh(slug);
    return { status: "success", message: "Deadline changed." };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function remindConsentAction(
  slug: string,
  id: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const sent = await remindConsentForm(db(), ctx, id, { sms: formData.get("sms") === "on" });
    if (sent.sms || sent.push) dispatchAfterResponse();
    refresh(slug);
    return {
      status: "success",
      message: `Reminder sent: ${sent.push} by notification, ${sent.sms} by SMS.`,
    };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function paperAnswerAction(
  slug: string,
  formId: string,
  studentId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await recordPaperAnswer(db(), ctx, formId, {
      studentId,
      guardianId: formData.get("guardianId"),
      answer: formData.get("answer"),
      note: formData.get("note"),
    });
    refresh(slug);
    return { status: "success", message: "Answer recorded." };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function cancelConsentAction(slug: string, id: string, _prev: FormState): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await cancelConsentForm(db(), ctx, id);
    refresh(slug);
    return { status: "success", message: "Form cancelled. Families can no longer answer it." };
  } catch (error) {
    return toFormError(error);
  }
}
