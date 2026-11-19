import type { Metadata } from "next";
import { Alert } from "@/components/ui/alert";
import { StatusText } from "@/components/ui/badge";
import { SettingRow } from "@/components/ui/layout";
import { getMfaStatus } from "@/server/auth/mfa";
import { PASSWORD_MIN_LENGTH } from "@/server/auth/password";
import { db } from "@/server/db/client";
import { requireUser } from "@/web/auth";
import { PasswordForm } from "../account-forms";
import { EnableMfa, ManageMfa } from "./mfa-controls";

export const metadata: Metadata = { title: "Security" };

/** How you sign in: your password and two-step verification. */
export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ required?: string }>;
}) {
  const [user, { required }] = await Promise.all([requireUser(), searchParams]);
  const status = await getMfaStatus(db(), user.id);
  const mfa = (
    <SettingRow
      title="Two-step verification"
      description="After your password, sign-in asks for a code from an authenticator app on your phone."
      aside={
        status.enabled ? (
          <StatusText tone="positive">On</StatusText>
        ) : (
          <StatusText tone="neutral">Off</StatusText>
        )
      }
    >
      {!status.enabled && required === "platform" && (
        <Alert tone="info">
          Platform administration requires two-step verification. Set it up to continue.
        </Alert>
      )}
      {!status.enabled && required === "school" && (
        <Alert tone="info">
          Your school requires two-step verification for your role. Set it up to continue.
        </Alert>
      )}
      {status.enabled ? <ManageMfa remaining={status.recoveryCodesRemaining} /> : <EnableMfa />}
    </SettingRow>
  );
  const password = (
    <SettingRow title="Password" description="Changing your password signs you out on your other devices.">
      <PasswordForm minLength={PASSWORD_MIN_LENGTH} email={user.email} />
    </SettingRow>
  );
  // When two-step verification is what stands between the person and their school, it comes first.
  return (
    <div className="divide-y divide-line">
      {required && !status.enabled ? (
        <>
          {mfa}
          {password}
        </>
      ) : (
        <>
          {password}
          {mfa}
        </>
      )}
    </div>
  );
}
