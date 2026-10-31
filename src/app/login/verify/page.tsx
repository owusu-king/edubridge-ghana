import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Wordmark } from "@/components/ui/wordmark";
import { safeRedirectPath } from "@/lib/format";
import { MFA_COOKIE } from "@/web/session-cookie";
import { VerifyForm } from "./verify-form";

export const metadata: Metadata = { title: "Two-step verification" };

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!(await cookies()).get(MFA_COOKIE)) redirect("/login");
  const { next } = await searchParams;
  return (
    <div className="flex min-h-dvh flex-col px-5 py-6 sm:px-8">
      <header>
        <Wordmark />
      </header>
      <main className="flex flex-1 items-center justify-center py-12">
        <div className="w-full max-w-sm">
          <h1 className="font-display text-2xl font-medium tracking-tight">Two-step verification</h1>
          <p className="mt-2 mb-8 text-base text-ink-2">Enter a code to finish signing in.</p>
          <VerifyForm next={next ? safeRedirectPath(next) : undefined} />
        </div>
      </main>
    </div>
  );
}
