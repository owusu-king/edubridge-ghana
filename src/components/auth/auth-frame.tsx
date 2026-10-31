import type { ReactNode } from "react";
import { Wordmark } from "@/components/ui/wordmark";

/** Centered single-column frame for sign-in and account recovery pages. */
export function AuthFrame({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col px-5 py-6 sm:px-8">
      <header>
        <Wordmark />
      </header>
      <main className="flex flex-1 items-center justify-center py-12">
        <div className="w-full max-w-sm">
          <h1 className="font-display text-2xl font-medium tracking-tight">{title}</h1>
          {intro && <div className="mt-2 mb-8 text-base text-ink-2">{intro}</div>}
          {children}
        </div>
      </main>
    </div>
  );
}
