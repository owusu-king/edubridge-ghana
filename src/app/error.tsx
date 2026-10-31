"use client";

import { Button } from "@/components/ui/button";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-[60dvh] flex-col items-center justify-center px-6 text-center">
      <h1 className="font-display text-xl font-medium">Something went wrong</h1>
      <p className="mt-2 max-w-sm text-base text-ink-2">
        The page could not be loaded. Try again; if the problem continues, contact support
        {error.digest ? (
          <>
            {" "}
            with reference <span className="font-mono text-sm">{error.digest}</span>
          </>
        ) : null}
        .
      </p>
      <Button variant="secondary" className="mt-6" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
