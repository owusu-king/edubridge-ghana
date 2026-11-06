import type { Metadata, Route } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getParentSession, parentNext } from "@/web/parent-auth";
import { RequestCodeForm } from "./request-code-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function ParentLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const target = parentNext(next);
  if (await getParentSession()) redirect(target as Route);
  return (
    <div className="mx-auto max-w-sm pt-4 sm:pt-10">
      <h1 className="font-display text-2xl font-medium tracking-tight">Sign in as a parent</h1>
      <p className="mt-2 mb-8 text-base text-ink-2">
        Enter the mobile number your child&apos;s school has for you. We will text you a 6-digit code. There
        is no password to remember.
      </p>
      <RequestCodeForm next={target === "/p" ? undefined : target} />
      <p className="mt-10 text-sm text-ink-3">
        School staff?{" "}
        <Link href="/login" className="font-medium text-accent hover:underline">
          Sign in here
        </Link>
      </p>
    </div>
  );
}
