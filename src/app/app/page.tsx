import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/web/auth";
import { getParentSession } from "@/web/parent-auth";
import { PARENT_COOKIE } from "@/web/session-cookie";

/**
 * Where the installed app opens (the manifest's start_url, 2026-11-19). An installed copy is never sent to the landing
 * page: staff who are signed in go to their school, parents to their children, and everyone else to sign in. A
 * parent whose sign-in has ended (the browser still holds the parent view's cookie) goes to the parent sign-in.
 */
export default async function AppStart() {
  if (await getCurrentUser()) redirect("/");
  if (await getParentSession()) redirect("/p");
  if ((await cookies()).get(PARENT_COOKIE)) redirect("/p/login");
  redirect("/login");
}
