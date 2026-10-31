import { sql } from "drizzle-orm";
import { db } from "@/server/db/client";

export const dynamic = "force-dynamic";

/** Liveness and database readiness. Exposes no configuration details. */
export async function GET() {
  try {
    await db().execute(sql`select 1`);
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
