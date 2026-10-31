"use server";

import { redirect } from "next/navigation";
import { signOutCurrentSession } from "@/web/auth";

export async function signOut(): Promise<void> {
  await signOutCurrentSession();
  redirect("/login");
}
