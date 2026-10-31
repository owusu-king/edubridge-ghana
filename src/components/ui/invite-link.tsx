"use client";

import { Alert } from "@/components/ui/alert";
import { CopyField } from "@/components/ui/copy-field";

export interface InviteLink {
  inviteUrl: string;
  email: string;
  /** ISO timestamp. */
  expiresAt: string;
}

/** Shows a freshly issued invitation link. It is displayed once and cannot be retrieved again. */
export function InviteLinkPanel({ result }: { result: InviteLink }) {
  const expires = new Intl.DateTimeFormat("en-GH", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(result.expiresAt));
  return (
    <div className="space-y-4 rounded-lg border border-line bg-canvas p-5">
      <Alert tone="info">
        Send this link to <strong className="font-semibold">{result.email}</strong> through a channel you
        trust. It works once, expires on {expires}, and will not be shown again.
      </Alert>
      <CopyField label="Invitation link" value={result.inviteUrl} />
    </div>
  );
}
