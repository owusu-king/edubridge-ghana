import type { Metadata, Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Wordmark } from "@/components/ui/wordmark";
import { getParentSession } from "@/web/parent-auth";
import { signOutParentAction } from "./actions";

export const metadata: Metadata = {
  title: { default: "Parents", template: "%s · EduBridge for parents" },
  referrer: "no-referrer",
};

/**
 * The parent experience: mobile first, server-rendered, little JavaScript (ordinary Android phones on
 * mobile data). Kept apart from the staff shell and its libraries.
 */
export default async function ParentLayout({ children }: { children: ReactNode }) {
  const session = await getParentSession();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-xl items-center justify-between px-4">
          <Link href={"/p" as Route} className="rounded-md" aria-label="EduBridge for parents, home">
            <Wordmark />
          </Link>
          {session && (
            <form action={signOutParentAction}>
              <button
                type="submit"
                className="-mr-2 inline-flex h-11 items-center rounded-lg px-3 text-sm font-medium text-ink-2 hover:bg-subtle hover:text-ink"
              >
                Sign out
              </button>
            </form>
          )}
        </div>
      </header>
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-6 sm:py-8">{children}</main>
      <footer className="mx-auto w-full max-w-xl px-4 pb-6 text-xs text-ink-3">
        EduBridge · Fees and school information for parents
      </footer>
    </div>
  );
}
