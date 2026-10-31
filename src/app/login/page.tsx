import type { Metadata, Route } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Wordmark } from "@/components/ui/wordmark";
import { safeRedirectPath } from "@/lib/format";
import { getCurrentUser } from "@/web/auth";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reset?: string }>;
}) {
  const { next, reset } = await searchParams;
  const target = next ? safeRedirectPath(next) : undefined;
  if (await getCurrentUser()) redirect((target ?? "/") as Route);

  return (
    <div className="flex min-h-dvh flex-col px-5 py-6 sm:px-8">
      <header>
        <Wordmark />
      </header>
      <main className="flex flex-1 items-center justify-center py-12">
        <div className="w-full max-w-sm">
          <h1 className="font-display text-2xl font-medium tracking-tight">Sign in</h1>
          <p className="mt-2 mb-8 text-base text-ink-2">
            Use the email address your school registered for you.
          </p>
          {reset && (
            <Alert tone="positive" className="mb-5">
              Your password has been changed. Sign in with your new password.
            </Alert>
          )}
          <SignInForm next={target} />
          <p className="mt-8 text-sm">
            <Link href={"/forgot-password" as Route} className="font-medium text-accent hover:underline">
              Forgotten your password?
            </Link>
          </p>
        </div>
      </main>
      <footer className="text-xs text-ink-3">
        EduBridge · School operations for international and private schools
      </footer>
    </div>
  );
}
