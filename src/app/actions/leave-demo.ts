"use server";

import { redirect } from "next/navigation";
import { signOutCurrentSession } from "@/web/auth";

/**
 * Ends a demo visit and returns to the landing page, at "Book a demo" when asked (2026-11-19). The visit must end
 * first: the landing page sends a signed-in visitor back into the demo school.
 */
export async function leaveDemo(toVisit: boolean): Promise<void> {
  await signOutCurrentSession();
  redirect(toVisit ? "/#visit" : "/");
}
