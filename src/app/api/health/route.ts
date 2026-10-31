import { db } from "@/server/db/client";
import { databaseIsHealthy } from "@/server/health/service";

export const dynamic = "force-dynamic";

/** Liveness and database readiness. Exposes no configuration details. */
export async function GET() {
  const healthy = await databaseIsHealthy(db());
  return Response.json(
    { status: healthy ? "ok" : "unavailable" },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
