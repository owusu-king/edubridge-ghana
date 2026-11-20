"use client";

import { useEffect } from "react";

/**
 * The installed app never shows the landing page (2026-11-19): if its window reaches it (a session ended while it was
 * open, say), it goes on to /app, which sends the person to sign-in or their own pages. Browser tabs are unaffected.
 */
export function InstalledRedirect() {
  useEffect(() => {
    const installed =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (installed) window.location.replace("/app");
  }, []);
  return null;
}
