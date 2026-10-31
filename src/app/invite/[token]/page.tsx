import type { Metadata, Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button, buttonStyles } from "@/components/ui/button";
import { Wordmark } from "@/components/ui/wordmark";
import { PASSWORD_MIN_LENGTH } from "@/server/auth/password";
import { ROLE_LABELS } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { findInvitation } from "@/server/invitations/service";
import { getCurrentUser } from "@/web/auth";
import { signOut } from "@/app/actions/sign-out";
import { acceptInvitationAction } from "./actions";
import { AcceptForm, NewAccountForm } from "./accept-form";

export const metadata: Metadata = { title: "Invitation", referrer: "no-referrer" };

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col px-5 py-6 sm:px-8">
      <header>
        <Wordmark />
      </header>
      <main className="flex flex-1 items-center justify-center py-12">
        <div className="w-full max-w-sm">
          <h1 className="font-display text-2xl font-medium tracking-tight">{title}</h1>
          {children}
        </div>
      </main>
    </div>
  );
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const [invitation, user] = await Promise.all([findInvitation(db(), token), getCurrentUser()]);

  if (!invitation) {
    return (
      <Frame title="Invitation unavailable">
        <p className="mt-3 text-base text-ink-2">
          This link is invalid, has already been used, or has expired. Ask the person who invited you for a
          new link.
        </p>
      </Frame>
    );
  }

  const roles = invitation.roles.map((r) => ROLE_LABELS[r]).join(", ");
  const intro = (
    <p className="mt-2 mb-8 text-base text-ink-2">
      You have been invited to join{" "}
      <strong className="font-semibold text-ink">{invitation.schoolName}</strong> as {roles}.
    </p>
  );
  const action = acceptInvitationAction.bind(null, token, invitation.schoolSlug);

  if (user && user.email.toLowerCase() === invitation.email.toLowerCase()) {
    return (
      <Frame title="Join your school">
        {intro}
        <AcceptForm action={action} />
      </Frame>
    );
  }

  if (user) {
    return (
      <Frame title="Different account">
        {intro}
        <p className="mb-6 text-base text-ink-2">
          This invitation is for <strong className="font-semibold text-ink">{invitation.email}</strong>, but
          you are signed in as {user.email}. Sign out, then open this link again.
        </p>
        <form action={signOut}>
          <Button type="submit" variant="secondary" className="w-full">
            Sign out
          </Button>
        </form>
      </Frame>
    );
  }

  if (invitation.accountExists) {
    return (
      <Frame title="Sign in to accept">
        {intro}
        <p className="mb-6 text-base text-ink-2">
          You already have an EduBridge account as{" "}
          <strong className="font-semibold text-ink">{invitation.email}</strong>.
        </p>
        <Link
          href={`/login?next=${encodeURIComponent(`/invite/${token}`)}` as Route}
          className={buttonStyles("primary", "md", "w-full")}
        >
          Sign in
        </Link>
      </Frame>
    );
  }

  return (
    <Frame title="Create your account">
      {intro}
      <NewAccountForm action={action} email={invitation.email} minLength={PASSWORD_MIN_LENGTH} />
    </Frame>
  );
}
