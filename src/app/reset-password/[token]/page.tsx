import type { Metadata, Route } from "next";
import Link from "next/link";
import { AuthFrame } from "@/components/auth/auth-frame";
import { buttonStyles } from "@/components/ui/button";
import { PASSWORD_MIN_LENGTH } from "@/server/auth/password";
import { isResetTokenValid } from "@/server/auth/password-reset";
import { db } from "@/server/db/client";
import { resetPasswordAction } from "./actions";
import { ResetForm } from "./reset-form";

export const metadata: Metadata = { title: "Choose a new password", referrer: "no-referrer" };

export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!(await isResetTokenValid(db(), token))) {
    return (
      <AuthFrame title="Link expired" intro="This reset link is invalid, has been used, or has expired.">
        <Link href={"/forgot-password" as Route} className={buttonStyles("primary", "md", "w-full")}>
          Request a new link
        </Link>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame
      title="Choose a new password"
      intro="You will be signed out everywhere and asked to sign in again."
    >
      <ResetForm action={resetPasswordAction.bind(null, token)} minLength={PASSWORD_MIN_LENGTH} />
    </AuthFrame>
  );
}
