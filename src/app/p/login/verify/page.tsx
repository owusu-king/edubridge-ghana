import type { Metadata, Route } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/server/db/client";
import { pendingCodePhone } from "@/server/parents/sign-in";
import { maskPhone } from "@/lib/phone";
import { getParentSession, parentNext } from "@/web/parent-auth";
import { PARENT_CODE_COOKIE } from "@/web/session-cookie";
import { VerifyCodeForm } from "./verify-code-form";

export const metadata: Metadata = { title: "Enter your code" };

export default async function ParentVerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const target = parentNext(next);
  if (await getParentSession()) redirect(target as Route);
  const requestId = (await cookies()).get(PARENT_CODE_COOKIE)?.value;
  const phone = requestId ? await pendingCodePhone(db(), requestId) : null;
  const again = (target === "/p" ? "/p/login" : `/p/login?next=${encodeURIComponent(target)}`) as Route;
  return (
    <div className="mx-auto max-w-sm pt-4 sm:pt-10">
      <h1 className="font-display text-2xl font-medium tracking-tight">Enter your code</h1>
      {phone ? (
        <>
          <p className="mt-2 mb-8 text-base text-ink-2">
            If a school has <span className="font-medium whitespace-nowrap text-ink">{maskPhone(phone)}</span>{" "}
            on file, we have texted it a 6-digit code. It works for 10 minutes.
          </p>
          <VerifyCodeForm next={target === "/p" ? undefined : target} again={again} />
        </>
      ) : (
        <>
          <p className="mt-2 mb-8 text-base text-ink-2">
            This code has expired or has already been used. Ask for a new one.
          </p>
          <Link
            href={again}
            className="inline-flex h-11 items-center rounded-lg bg-accent px-4 text-base font-medium text-white hover:bg-accent-hover"
          >
            Text me a new code
          </Link>
        </>
      )}
    </div>
  );
}
