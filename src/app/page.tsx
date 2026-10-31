import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { isPlatformAdmin } from "@/server/platform/service";
import { listUserSchools } from "@/server/tenancy/service";
import { schoolPath } from "@/lib/routes";
import { requireUser } from "@/web/auth";

/** Entry point: go straight to the only school, otherwise let the user choose. */
export default async function Home() {
  const user = await requireUser();
  const schools = await listUserSchools(db(), user.id);
  if (schools.length === 1 && schools[0]) redirect(schoolPath(schools[0].slug));
  if (schools.length === 0 && (await isPlatformAdmin(db(), user.id))) redirect("/admin");
  redirect("/schools");
}
