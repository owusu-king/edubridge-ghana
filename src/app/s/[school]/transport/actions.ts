"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { assignStudent, endAssignment } from "@/server/transport/assignments";
import {
  saveRoute,
  saveStop,
  saveVehicle,
  setFares,
  setNotifyFamilies,
  setRouteArchived,
  setStopArchived,
  setTransportFeeItem,
  setVehicleArchived,
} from "@/server/transport/setup";
import { markBoarded, markLeft } from "@/server/transport/trips";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

/** Transport (R4-5). */

const fields = (formData: FormData) => Object.fromEntries(formData) as Record<string, unknown>;
const refresh = (slug: string, ...segments: string[]) => {
  revalidatePath(schoolPath(slug, "transport"));
  for (const s of segments) revalidatePath(schoolPath(slug, `transport/${s}`));
};

async function run(
  slug: string,
  formData: FormData | null,
  work: (ctx: Awaited<ReturnType<typeof requireTenant>>["ctx"]) => Promise<unknown>,
  message: string,
  ...segments: string[]
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    await work(ctx);
  } catch (error) {
    return toFormError(error, formData ?? undefined);
  }
  refresh(slug, ...segments);
  return { status: "success", message };
}

export async function saveVehicleAction(
  slug: string,
  vehicleId: string | null,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(
    slug,
    formData,
    (ctx) => saveVehicle(db(), ctx, fields(formData), vehicleId ?? undefined),
    "Saved.",
    "vehicles",
  );
}

export async function setVehicleArchivedAction(
  slug: string,
  vehicleId: string,
  archived: boolean,
  _prev: FormState,
): Promise<FormState> {
  return run(slug, null, (ctx) => setVehicleArchived(db(), ctx, vehicleId, archived), "Saved.", "vehicles");
}

export async function saveRouteAction(
  slug: string,
  routeId: string | null,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(
    slug,
    formData,
    (ctx) => saveRoute(db(), ctx, fields(formData), routeId ?? undefined),
    "Saved.",
    ...(routeId ? [`routes/${routeId}`] : []),
  );
}

export async function setRouteArchivedAction(
  slug: string,
  routeId: string,
  archived: boolean,
  _prev: FormState,
): Promise<FormState> {
  return run(
    slug,
    null,
    (ctx) => setRouteArchived(db(), ctx, routeId, archived),
    "Saved.",
    `routes/${routeId}`,
  );
}

export async function saveStopAction(
  slug: string,
  routeId: string,
  stopId: string | null,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(
    slug,
    formData,
    (ctx) => saveStop(db(), ctx, routeId, fields(formData), stopId ?? undefined),
    "Saved.",
    `routes/${routeId}`,
  );
}

export async function setStopArchivedAction(
  slug: string,
  routeId: string,
  stopId: string,
  archived: boolean,
  _prev: FormState,
): Promise<FormState> {
  return run(
    slug,
    null,
    (ctx) => setStopArchived(db(), ctx, routeId, stopId, archived),
    "Saved.",
    `routes/${routeId}`,
  );
}

export async function setFaresAction(
  slug: string,
  routeId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(
    slug,
    formData,
    (ctx) => setFares(db(), ctx, routeId, fields(formData)),
    "Fares saved.",
    `routes/${routeId}`,
  );
}

export async function assignStudentAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(slug, formData, (ctx) => assignStudent(db(), ctx, fields(formData)), "Saved.", "students");
}

export async function endAssignmentAction(
  slug: string,
  assignmentId: string,
  _prev: FormState,
): Promise<FormState> {
  return run(slug, null, (ctx) => endAssignment(db(), ctx, assignmentId), "Taken off the route.", "students");
}

export async function setFeeItemAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(
    slug,
    formData,
    (ctx) => setTransportFeeItem(db(), ctx, formData.get("feeItemId")),
    "Saved.",
    "settings",
  );
}

export async function setNotifyAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return run(
    slug,
    formData,
    (ctx) => setNotifyFamilies(db(), ctx, formData.get("notify") === "on"),
    "Saved.",
    "settings",
  );
}

export async function markBoardedAction(
  slug: string,
  routeId: string,
  direction: string,
  studentId: string,
  _prev: FormState,
): Promise<FormState> {
  return run(
    slug,
    null,
    (ctx) => markBoarded(db(), ctx, routeId, direction, studentId),
    "On the bus.",
    "trips",
  );
}

export async function markLeftAction(
  slug: string,
  routeId: string,
  direction: string,
  studentId: string,
  _prev: FormState,
): Promise<FormState> {
  return run(
    slug,
    null,
    (ctx) => markLeft(db(), ctx, routeId, direction, studentId),
    "Off the bus.",
    "trips",
  );
}
