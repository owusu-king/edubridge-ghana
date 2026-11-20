"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * On "System", the page follows the device's light or dark setting by itself (globals.css), but the window's
 * title-bar colour comes from the server (app/layout.tsx). When the device switches while EduBridge is open, refresh
 * from the server so the title bar of an installed app follows too. Nothing happens for an explicit Light or Dark.
 */
export function SystemThemeWatcher() {
  const router = useRouter();
  useEffect(() => {
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => {
      if (!document.documentElement.dataset.theme) router.refresh();
    };
    dark.addEventListener("change", follow);
    return () => dark.removeEventListener("change", follow);
  }, [router]);
  return null;
}
