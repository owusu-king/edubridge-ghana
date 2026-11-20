"use client";

import { Smartphone } from "lucide-react";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { INSTALL_HELP, promptInstall, useInstall } from "@/components/shell/install";

const DISMISSED = "edubridge-install-note-dismissed";

// "Not now", remembered on this phone. The server draws the page as if dismissed, so nothing flashes before the
// phone has said whether it can install.
const dismissListeners = new Set<() => void>();
const subscribeDismissed = (listener: () => void) => {
  dismissListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    dismissListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
};
const readDismissed = () => localStorage.getItem(DISMISSED) === "1";
const dismiss = () => {
  localStorage.setItem(DISMISSED, "1");
  dismissListeners.forEach((l) => l());
};

/**
 * Offers parents EduBridge on their home screen (2026-11-19): one tap to their children's fees, receipts and report
 * cards, and the pages they have opened still work on a weak network. Shown only where the phone can install it and
 * EduBridge is not installed yet; "Not now" hides it on this phone for good.
 */
export function InstallNote() {
  const install = useInstall();
  const dismissed = useSyncExternalStore(subscribeDismissed, readDismissed, () => true);
  if (!install || dismissed) return null;
  return (
    <section
      aria-labelledby="install-note"
      className="flex gap-3 rounded-lg border border-accent/30 bg-accent-soft/50 p-4"
    >
      <Smartphone aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <h2 id="install-note" className="text-base font-semibold text-ink">
          {install === "safari-mac" ? "Add EduBridge to your Dock" : "Add EduBridge to your home screen"}
        </h2>
        <p className="mt-1 text-sm text-ink-2">
          Open your children&apos;s fees, receipts and report cards in one tap. Pages you have opened also
          work when the network is weak.
        </p>
        {install !== "prompt" && <p className="mt-2 text-sm text-ink">{INSTALL_HELP[install]}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {install === "prompt" && (
            <Button
              size="sm"
              onClick={() =>
                void promptInstall().then((done) => {
                  if (done) toast("EduBridge is on your home screen.");
                })
              }
            >
              Install
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={dismiss}>
            Not now
          </Button>
        </div>
      </div>
    </section>
  );
}
