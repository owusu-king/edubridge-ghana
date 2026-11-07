import { cookies } from "next/headers";
import { handleApiRequest } from "@/server/api";
import { db } from "@/server/db/client";
import { SESSION_COOKIE } from "@/web/session-cookie";

export const dynamic = "force-dynamic";

/** `/api/v1` (see src/server/api). Payment provider callbacks have their own routes. */
async function handle(request: Request): Promise<Response> {
  const cookieToken = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return handleApiRequest(db(), request, { cookieToken });
}

export { handle as GET, handle as POST, handle as PUT, handle as DELETE };
