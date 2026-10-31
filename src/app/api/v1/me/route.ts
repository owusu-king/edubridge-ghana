import { db } from "@/server/db/client";
import { listUserSchools } from "@/server/tenancy/service";
import { apiError, authenticateApiRequest } from "@/web/api";

export const dynamic = "force-dynamic";

/** The signed-in user and the schools they can access. */
export async function GET(request: Request) {
  const user = await authenticateApiRequest(request);
  if (!user) return apiError(401, "unauthenticated", "Sign in to continue.");
  const schools = await listUserSchools(db(), user.id);
  return Response.json(
    { user: { id: user.id, name: user.name, email: user.email }, schools },
    { headers: { "Cache-Control": "no-store" } },
  );
}
