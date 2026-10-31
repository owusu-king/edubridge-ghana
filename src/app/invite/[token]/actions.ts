"use server";

import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { acceptInvitation } from "@/server/invitations/service";
import { schoolPath } from "@/lib/routes";
import { getClientInfo, getCurrentUser, setSessionCookie } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

export async function acceptInvitationAction(
  token: string,
  schoolSlug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await getCurrentUser();
  try {
    const client = await getClientInfo();
    const result = user
      ? await acceptInvitation(db(), token, { kind: "signed-in", userId: user.id, email: user.email }, client)
      : await acceptInvitation(
          db(),
          token,
          {
            kind: "new-account",
            name: String(formData.get("name") ?? ""),
            password: String(formData.get("password") ?? ""),
          },
          client,
        );
    if (result.session) await setSessionCookie(result.session.token);
  } catch (error) {
    return toFormError(error, formData);
  }
  redirect(schoolPath(schoolSlug));
}
