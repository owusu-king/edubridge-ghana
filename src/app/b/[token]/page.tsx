import type { Metadata, Route } from "next";
import Link from "next/link";
import { BalanceFigure, ChildFacts } from "@/components/parents/balance";
import { Wordmark } from "@/components/ui/wordmark";
import { db } from "@/server/db/client";
import { readBalanceLink } from "@/server/parents/balance-links";
import { formatCalendarDate, formatDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "School fees balance",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

/**
 * A balance link from a fee reminder: one child's balance, read-only, for 7 days, without signing in.
 * Shows only what the SMS already said (school, first name, balance) plus the payment position.
 */
export default async function BalanceLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const view = await readBalanceLink(db(), token);
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-xl items-center px-4">
          <Wordmark />
        </div>
      </header>
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-8">
        {view ? (
          <div className="space-y-6">
            <div>
              <p className="text-sm text-ink-3">{view.schoolName}</p>
              <h1 className="mt-1 font-display text-2xl font-medium tracking-tight">
                {view.child.firstName}&apos;s school fees
              </h1>
            </div>
            <section className="rounded-lg border border-line bg-surface px-5 py-5 shadow-raised">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-3">
                  <p className="text-sm text-ink-3">As of {formatCalendarDate(view.asOf)}</p>
                  <ChildFacts child={view.child} />
                </div>
                <BalanceFigure pesewas={view.child.balancePesewas} size="lg" />
              </div>
            </section>
            <p className="text-sm text-ink-2">
              Pay at the school office or by Mobile Money. To see the full statement and download receipts,
              sign in with the number this link was sent to.
            </p>
            <Link
              href={"/p/login" as Route}
              className="inline-flex h-11 items-center rounded-lg bg-accent px-4 text-base font-medium text-white hover:bg-accent-hover"
            >
              Sign in as a parent
            </Link>
            <p className="text-xs text-ink-3">
              This private link was sent by text message and works until{" "}
              {formatDate(view.expiresAt, view.timeZone)}. Anyone you share it with can see this page.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <h1 className="font-display text-2xl font-medium tracking-tight">This link has expired</h1>
            <p className="text-base text-ink-2">
              Balance links work for 7 days. Sign in with your mobile number to see your children&apos;s fees.
            </p>
            <Link
              href={"/p/login" as Route}
              className="inline-flex h-11 items-center rounded-lg bg-accent px-4 text-base font-medium text-white hover:bg-accent-hover"
            >
              Sign in as a parent
            </Link>
          </div>
        )}
      </main>
    </div>
  );
}
