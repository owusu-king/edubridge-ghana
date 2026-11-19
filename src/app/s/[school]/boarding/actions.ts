"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { endPlacement, placeBoarder, signInBoarder, signOutBoarder } from "@/server/boarding/boarders";
import {
  addBeds,
  addRoom,
  appointHouseStaff,
  archiveBed,
  endHouseStaff,
  saveHouse,
  setBoardingFeeItem,
  setHouseArchived,
} from "@/server/boarding/houses";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

/** Boarding (R4-8). */

type Ctx = Awaited<ReturnType<typeof requireTenant>>["ctx"];
const fields = (formData: FormData) => Object.fromEntries(formData) as Record<string, unknown>;

async function run(
  slug: string,
  formData: FormData | null,
  work: (ctx: Ctx) => Promise<unknown>,
  message: string,
  ...segments: string[]
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await work(ctx);
  } catch (error) {
    return toFormError(error, formData ?? undefined);
  }
  revalidatePath(schoolPath(slug, "boarding"));
  for (const s of segments) revalidatePath(schoolPath(slug, `boarding/${s}`));
  return { status: "success", message };
}

const house = (id: string) => `houses/${id}`;

export async function saveHouseAction(
  slug: string,
  houseId: string | null,
  _p: FormState,
  formData: FormData,
) {
  return run(
    slug,
    formData,
    (ctx) => saveHouse(db(), ctx, fields(formData), houseId ?? undefined),
    "Saved.",
    ...(houseId ? [house(houseId)] : []),
  );
}

export async function setHouseArchivedAction(
  slug: string,
  houseId: string,
  archived: boolean,
  _p: FormState,
) {
  return run(slug, null, (ctx) => setHouseArchived(db(), ctx, houseId, archived), "Saved.", house(houseId));
}

export async function addRoomAction(slug: string, houseId: string, _p: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    (ctx) => addRoom(db(), ctx, houseId, fields(formData)),
    "Room added.",
    house(houseId),
  );
}

export async function addBedsAction(
  slug: string,
  houseId: string,
  roomId: string,
  _p: FormState,
  formData: FormData,
) {
  return run(
    slug,
    formData,
    (ctx) => addBeds(db(), ctx, roomId, formData.get("beds")),
    "Beds added.",
    house(houseId),
  );
}

export async function archiveBedAction(slug: string, houseId: string, bedId: string, _p: FormState) {
  return run(slug, null, (ctx) => archiveBed(db(), ctx, bedId), "Bed taken out of use.", house(houseId));
}

export async function appointStaffAction(slug: string, houseId: string, _p: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    (ctx) => appointHouseStaff(db(), ctx, houseId, formData.get("membershipId")),
    "Appointed.",
    house(houseId),
  );
}

export async function endStaffAction(slug: string, houseId: string, staffId: string, _p: FormState) {
  return run(slug, null, (ctx) => endHouseStaff(db(), ctx, staffId), "Ended.", house(houseId));
}

export async function placeBoarderAction(slug: string, houseId: string, _p: FormState, formData: FormData) {
  return run(slug, formData, (ctx) => placeBoarder(db(), ctx, fields(formData)), "Saved.", house(houseId));
}

export async function endPlacementAction(slug: string, houseId: string, assignmentId: string, _p: FormState) {
  return run(
    slug,
    null,
    (ctx) => endPlacement(db(), ctx, assignmentId),
    "Taken out of boarding.",
    house(houseId),
  );
}

export async function signOutAction(slug: string, _p: FormState, formData: FormData) {
  return run(slug, formData, (ctx) => signOutBoarder(db(), ctx, fields(formData)), "Signed out.", "exeats");
}

export async function signInAction(slug: string, exeatId: string, _p: FormState) {
  return run(slug, null, (ctx) => signInBoarder(db(), ctx, exeatId), "Signed back in.", "exeats");
}

export async function setFeeItemAction(slug: string, _p: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    (ctx) => setBoardingFeeItem(db(), ctx, formData.get("feeItemId")),
    "Saved.",
    "settings",
  );
}
