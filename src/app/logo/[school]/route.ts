import { db } from "@/server/db/client";
import { readSchoolLogo } from "@/server/tenancy/branding";

export const dynamic = "force-dynamic";

/** A school's logo (public, like the sign on its gate): shown in the app, the parent view and documents. */
export async function GET(_request: Request, { params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  if (!/^[a-z0-9-]{1,63}$/.test(school)) return new Response("Not found", { status: 404 });
  const logo = await readSchoolLogo(db(), school);
  if (!logo) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(logo.content), {
    headers: {
      "Content-Type": logo.mime,
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
