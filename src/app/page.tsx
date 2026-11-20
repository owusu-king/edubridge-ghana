import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { introVideo } from "@/components/landing/intro-video";
import { LandingPage } from "@/components/landing/landing-page";
import { db } from "@/server/db/client";
import { demoSchoolSlug, findDemoVisit } from "@/server/demo/visit";
import { isPlatformAdmin } from "@/server/platform/service";
import { listUserSchools } from "@/server/tenancy/service";
import { schoolPath } from "@/lib/routes";
import { getCurrentUser } from "@/web/auth";
import { getParentSession } from "@/web/parent-auth";

export const metadata: Metadata = {
  title: { absolute: "EduBridge · The complete operating system for schools" },
  description:
    "Fees and finances, academics, staff, parents and daily operations in one connected platform, with early warning of what needs attention. For school owners in Ghana and beyond. Your first term is free.",
  // The landing page is the one page meant to be found (the app itself is not indexed: root layout).
  robots: { index: true, follow: true },
  openGraph: {
    title: "EduBridge · The complete operating system for schools",
    description: "Built for Africa. Ready for the world.",
    type: "website",
  },
};

const digits = (v: string | undefined) => v?.replace(/\D/g, "") || null;

/**
 * The site's front door. Signed-in staff go straight to their school (or choose one); a parent signed in to the
 * parent view goes to their children; everyone else sees the landing page (2026-11-19).
 */
export default async function Home() {
  const user = await getCurrentUser();
  if (!user) {
    // Only a live parent session: an old cookie alone must not hide the landing page.
    if (await getParentSession()) redirect("/p");
    const slug = demoSchoolSlug();
    const demo = slug ? Boolean(await findDemoVisit(db(), slug)) : false;
    return (
      <LandingPage
        demo={demo}
        video={introVideo()}
        contact={{
          phone: process.env.LANDING_PHONE?.trim() || null,
          whatsapp: digits(process.env.LANDING_WHATSAPP),
          email: process.env.LANDING_EMAIL?.trim() || null,
        }}
      />
    );
  }
  const schools = await listUserSchools(db(), user.id);
  if (schools.length === 1 && schools[0]) redirect(schoolPath(schools[0].slug));
  if (schools.length === 0 && (await isPlatformAdmin(db(), user.id))) redirect("/admin");
  redirect("/schools");
}
