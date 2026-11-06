"use server";

import type { Route } from "next";
import { redirect } from "next/navigation";
import { signOutParent } from "@/web/parent-auth";

export async function signOutParentAction(): Promise<void> {
  await signOutParent();
  redirect("/p/login" as Route);
}
