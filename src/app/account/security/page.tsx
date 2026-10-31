import type { Metadata } from "next";
import { Alert } from "@/components/ui/alert";
import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { getMfaStatus } from "@/server/auth/mfa";
import { db } from "@/server/db/client";
import { requireUser } from "@/web/auth";
import { EnableMfa, ManageMfa } from "./mfa-controls";

export const metadata: Metadata = { title: "Security" };

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ required?: string }>;
}) {
  const [user, { required }] = await Promise.all([requireUser(), searchParams]);
  const status = await getMfaStatus(db(), user.id);
  return (
    <Section
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
    </Section>
  );
}
