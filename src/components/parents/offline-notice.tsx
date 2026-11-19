"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const PARENT_CACHE = "edubridge-parent-v1";

/**
 * The parent view offline (PRT-07). Registers the service worker, which keeps the pages and receipts a
 * parent opened; when the phone is offline, says that what is shown is a saved copy and when it is from.
 * On the sign-in page (after signing out, or when the session ended) the saved copies are deleted.
 */
export function OfflineNotice({ renderedAt }: { renderedAt: string }) {
  const pathname = usePathname();
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator)
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Offline copies are an enhancement; the parent view works without them.
      });
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (!pathname.startsWith("/p/login") || !("caches" in window)) return;
    void caches.delete(PARENT_CACHE);
    navigator.serviceWorker?.controller?.postMessage({ type: "clear-parent" });
    // Signed out: this phone stops receiving the family's notifications (the server has already removed them).
    void navigator.serviceWorker
      ?.getRegistration()
      .then((r) => r?.pushManager?.getSubscription())
      .then((s) => s?.unsubscribe())
      .catch(() => undefined);
  }, [pathname]);

  if (!offline || pathname.startsWith("/p/login")) return null;
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(renderedAt),
  );
  return (
    <div role="status" className="border-b border-caution/30 bg-caution-soft">
      <p className="mx-auto max-w-xl px-4 py-2 text-sm text-ink">
        <strong className="font-semibold">You are offline.</strong> This is the copy saved on this phone, as
        of {when}. Balances may have changed since; payments need a connection.
      </p>
    </div>
  );
}
