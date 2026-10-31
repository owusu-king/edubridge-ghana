import type { Metadata } from "next";
import { AuthFrame } from "@/components/auth/auth-frame";
import { RequestResetForm } from "./request-form";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <AuthFrame title="Reset your password" intro="Enter the email address you sign in with.">
      <RequestResetForm />
    </AuthFrame>
  );
}
