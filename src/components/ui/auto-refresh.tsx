"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the page from the server every few seconds while mounted, e.g. while a payment is being
 * confirmed. Pauses while the tab is hidden and stops after `maxMs`, so a forgotten tab stays quiet.
 */
export function AutoRefresh({ everyMs = 5000, maxMs = 10 * 60_000 }: { everyMs?: number; maxMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > maxMs) clearInterval(timer);
      else if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => clearInterval(timer);
  }, [router, everyMs, maxMs]);
  return null;
}
