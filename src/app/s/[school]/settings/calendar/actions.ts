"use server";

import { revalidatePath } from "next/cache";
import { createAcademicYear, setCurrentTerm, updateTerm } from "@/server/academics/calendar";
import { addHolidays, removeHoliday } from "@/server/academics/holidays";
import { db } from "@/server/db/client";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

const refresh = (slug: string) => revalidatePath(schoolPath(slug), "layout");

export async function createYearAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  // Rows without dates are left out, so a school can add fewer than three terms.
  const names = formData.getAll("termName").map(String);
  const starts = formData.getAll("termStart").map(String);
  const ends = formData.getAll("termEnd").map(String);
  const terms = names
    .map((name, i) => ({ name, startsOn: starts[i] ?? "", endsOn: ends[i] ?? "" }))
    .filter((t) => t.startsOn || t.endsOn);
  try {
    await createAcademicYear(db(), ctx, { name: formData.get("name"), terms });
  } catch (error) {
    return toFormError(error, formData);
  }
  refresh(slug);
  return { status: "success", message: "Academic year added." };
}

export async function updateTermAction(
  slug: string,
  termId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await updateTerm(db(), ctx, termId, {
      name: formData.get("name"),
      startsOn: formData.get("startsOn"),
      endsOn: formData.get("endsOn"),
    });
  } catch (error) {
    return toFormError(error, formData);
  }
  refresh(slug);
  return { status: "success", message: "Term updated." };
}

export async function makeCurrentAction(slug: string, termId: string, _prev: FormState): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await setCurrentTerm(db(), ctx, termId);
  } catch (error) {
    return toFormError(error);
  }
  refresh(slug);
  return { status: "success", message: "Current term changed." };
}

export async function addHolidayAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await addHolidays(db(), ctx, [
      { name: formData.get("name"), startsOn: formData.get("startsOn"), endsOn: formData.get("endsOn") },
    ]);
  } catch (error) {
    return toFormError(error, formData);
  }
  refresh(slug);
  return { status: "success", message: "Holiday added." };
}

/** Adds the public holidays ticked in the suggestions ("date|name" per checkbox). */
export async function addSuggestedHolidaysAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  const chosen = formData.getAll("holiday").map((v) => {
    const [date, ...name] = String(v).split("|");
    return { name: name.join("|"), startsOn: date, endsOn: date };
  });
  try {
    const added = await addHolidays(db(), ctx, chosen);
    refresh(slug);
    return { status: "success", message: `${added} ${added === 1 ? "holiday" : "holidays"} added.` };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function removeHolidayAction(slug: string, holidayId: string): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await removeHoliday(db(), ctx, holidayId);
  } catch (error) {
    return toFormError(error);
  }
  refresh(slug);
  return { status: "success", message: "Holiday removed." };
}
