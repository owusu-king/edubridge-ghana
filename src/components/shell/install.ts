"use client";

import { useSyncExternalStore } from "react";
import { registerServiceWorker } from "@/components/attendance/offline";

/**
 * Installing EduBridge as an app (2026-11-19): on a computer it then opens in its own window from the Start menu,
 * the taskbar or the Dock, with no browser bars and nothing to download from a store. Chrome and Edge (and Chrome on
 * Android) announce that they can install it; we keep that announcement and offer "Install EduBridge" in the profile
 * menu. Safari, Firefox on Android and (from iOS 16.4) Chrome, Edge and Firefox on iPhone and iPad make no such
 * announcement but can install from their own menus, so they get a pointer there instead. Firefox on a computer
 * cannot install a site from the page, in-app browsers (a link opened inside a social app) cannot install at all, and
 * an installed copy needs no offer, so nothing is shown there.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallKind = "prompt" | "safari-mac" | "safari-ios" | "ios-browser" | "firefox-android";

let deferred: BeforeInstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// Listening from the moment the code loads: the browser may announce before any menu is drawn. The service worker
// (production only) is registered here too, as some browsers offer installing only once one is running.
if (typeof window !== "undefined") {
  registerServiceWorker();
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    emit();
  });
}

function standalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/**
 * Browsers that can install EduBridge only from their own menus, from how they identify themselves; null for the
 * rest (Chrome and Edge announce instead, and Firefox on a computer cannot install a site from the page).
 */
export function menuInstallKind(ua: string, touchPoints: number): Exclude<InstallKind, "prompt"> | null {
  // Firefox on Android adds a site to the home screen from its own menu.
  if (/Android/.test(ua) && /Firefox\//.test(ua)) return "firefox-android";
  const safari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|Edg|Firefox|FxiOS|OPR/.test(ua);
  // An iPad asks for the desktop site, so it says Macintosh; its touch screen gives it away.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)) {
    if (safari) return "safari-ios";
    // Chrome, Edge and Firefox on iPhone and iPad can add to the home screen from iOS 16.4. Without a version (an
    // iPad asking for the desktop site), assume a current iOS. In-app browsers name none of these, and get nothing.
    const ios = /OS (\d+)_(\d+)/.exec(ua);
    const recent = !ios || Number(ios[1]) > 16 || (Number(ios[1]) === 16 && Number(ios[2]) >= 4);
    return recent && /CriOS|EdgiOS|FxiOS/.test(ua) ? "ios-browser" : null;
  }
  // Safari 17 and later can add a site to the Dock.
  const version = Number(/Version\/(\d+)/.exec(ua)?.[1] ?? 0);
  if (safari && /Macintosh/.test(ua) && version >= 17) return "safari-mac";
  return null;
}

function current(): InstallKind | null {
  if (installed || standalone()) return null;
  if (deferred) return "prompt";
  return menuInstallKind(navigator.userAgent, navigator.maxTouchPoints);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** How EduBridge can be installed in this browser, or null when it cannot (or already is). */
export function useInstall(): InstallKind | null {
  return useSyncExternalStore(subscribe, current, () => null);
}

/** Shows the browser's own install dialog; true when the person installed EduBridge. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  await event.prompt();
  const { outcome } = await event.userChoice;
  // The announcement can be used once; the browser makes a new one if it is dismissed.
  deferred = null;
  emit();
  return outcome === "accepted";
}

export const INSTALL_HELP: Record<Exclude<InstallKind, "prompt">, string> = {
  "safari-mac": "To install EduBridge, choose File, then Add to Dock, in Safari's menu bar.",
  "safari-ios": "To install EduBridge, tap the Share button, then Add to Home Screen.",
  "firefox-android": "To install EduBridge, tap Firefox's menu (⋮), then Add to Home screen.",
  "ios-browser":
    "To install EduBridge, tap Share (in the address bar or your browser's menu), then Add to Home Screen.",
};
