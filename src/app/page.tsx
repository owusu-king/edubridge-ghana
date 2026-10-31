import type { Route } from "next";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { listUserSchools } from "@/server/tenancy/service";
import { requireUser } from "@/web/auth";
import { schoolPath } from "@/lib/routes";

/** Entry point: go straight to the only school, otherwise let the user choose. */
export default async function Home() {
  const user = await requireUser();
  const schools = await listUserSchools(db(), user.id);
  redirect(schools.length === 1 && schools[0] ? schoolPath(schools[0].slug) : "/schools");
}
