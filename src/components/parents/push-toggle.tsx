"use client";

import { Bell, BellOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type Answer = { ok: true } | { ok: false; message: string };

type State =
  | "checking"
  | "unsupported"
  /** iPhone and iPad show web notifications only for sites added to the Home Screen. */
  | "install_first"
  | "blocked"
  | "off"
  | "on";

/** The VAPID public key (base64url) as the bytes PushManager.subscribe expects. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

/**
 * Notifications on this phone (PSH-01): free alerts when a school posts something, instead of an SMS. Only
 * that there is something new is shown; the details open here after sign-in. Turned off at sign-out.
 */
export function PushToggle({
  publicKey,
  save,
  remove,
  audience = "family",
  framed = true,
}: {
  /** Staff devices (PSH-01) get wording about school work rather than family news. */
  audience?: "family" | "staff";
  /**
   * Its own bordered box with a heading (the default). Off inside a settings row, which already has the
   * heading: then it says so plainly when this browser cannot show notifications, instead of disappearing.
   */
  framed?: boolean;
  publicKey: string;
  save: (subscription: unknown) => Promise<Answer>;
  remove: (endpoint: string) => Promise<Answer>;
}) {
  const [state, setState] = useState<State>("checking");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
      const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches;
      if (!supported) return setState(ios && !standalone ? "install_first" : "unsupported");
      if (Notification.permission === "denied") return setState("blocked");
      const existing = await (await registration())?.pushManager.getSubscription();
      // Keep the server's record bound to this sign-in (sign-out removes both, so this is the same family).
      if (existing) void save(existing.toJSON());
      setState(existing ? "on" : "off");
    })();
  }, [save]);

  async function turnOn() {
    setBusy(true);
    setMessage(null);
    try {
      if ((await Notification.requestPermission()) !== "granted") return setState("blocked");
      const reg = (await registration()) ?? (await navigator.serviceWorker.register("/sw.js"));
      await navigator.serviceWorker.ready;
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey),
      });
      const answer = await save(subscription.toJSON());
      if (!answer.ok) {
        await subscription.unsubscribe();
        return setMessage(answer.message);
      }
      setState("on");
      setMessage(
        audience === "staff"
          ? "Notifications are on for this device."
          : "Notifications are on for this phone.",
      );
    } catch {
      setMessage("Notifications could not be turned on. Try again, or check your connection.");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setMessage(null);
    try {
      const subscription = await (await registration())?.pushManager.getSubscription();
      if (subscription) {
        await remove(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setState("off");
      setMessage(
        audience === "staff"
          ? "Notifications are off for this device."
          : "Notifications are off. School news can still come by SMS.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (state === "checking") return null;
  if (state === "unsupported") {
    return framed ? null : <p className="text-sm text-ink-2">This browser cannot show notifications.</p>;
  }
  return (
    <section
      aria-labelledby={framed ? "push-heading" : undefined}
      aria-label={framed ? undefined : "Notifications on this device"}
      className={framed ? "space-y-2 rounded-lg border border-line bg-surface px-5 py-4" : "space-y-3"}
    >
      {framed && (
        <h2 id="push-heading" className="flex items-center gap-2 text-base font-semibold text-ink">
          {state === "on" ? (
            <Bell aria-hidden="true" className="size-4" />
          ) : (
            <BellOff aria-hidden="true" className="size-4" />
          )}
          {audience === "staff" ? "Notifications on this device" : "Notifications on this phone"}
        </h2>
      )}
      <p className="text-sm text-ink-2">
        {state === "install_first"
          ? "On iPhone and iPad, add EduBridge to your Home Screen first (Share, then Add to Home Screen), then open it from there."
          : state === "blocked"
            ? "Notifications are blocked for this site. Allow them in your browser's site settings, then come back here."
            : audience === "staff"
              ? state === "on"
                ? "You are told on this device when something needs you, such as a new online application. It ends when you sign out here."
                : "Be told on this device when something needs you, such as a new online application. The notification says only what is new; you open it after signing in."
              : state === "on"
                ? "You are told on this phone when a school posts news, instead of by SMS. Receipts and fee messages still come by SMS."
                : "Get school news on this phone for free, instead of an SMS. The notification only says there is news; you read it here."}
      </p>
      {state === "off" && (
        <Button size="sm" onClick={() => void turnOn()} pending={busy}>
          Turn on notifications
        </Button>
      )}
      {state === "on" && (
        <Button size="sm" variant="secondary" onClick={() => void turnOff()} pending={busy}>
          Turn off
        </Button>
      )}
      {message && (
        <p role="status" className="text-sm text-ink-2">
          {message}
        </p>
      )}
    </section>
  );
}
