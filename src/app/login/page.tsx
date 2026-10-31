import type { Route } from "next";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/ui/wordmark";
import { safeRedirectPath } from "@/lib/format";
import { getCurrentUser } from "@/web/auth";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
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
          <SignInForm next={target} />
          <p className="mt-8 text-sm text-ink-3">
            Forgotten your password? Ask your school administrator to reset it.
          </p>
        </div>
      </main>
      <footer className="text-xs text-ink-3">
        EduBridge · School operations for international and private schools
      </footer>
    </div>
  );
}
