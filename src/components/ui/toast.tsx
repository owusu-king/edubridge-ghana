"use client";

import { CircleAlert, CircleCheck, X } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import type { FormState } from "@/web/forms";
import { Alert } from "./alert";

/*
 * Short confirmations ("School profile saved.") shown at the bottom right for three seconds, instead of a
 * message left on the page. Errors that need the person to act stay beside the form. No library: a tiny
 * store, and one <Toaster> mounted in the root layout.
 */

type Tone = "positive" | "critical";
interface Toast {
  id: number;
  message: string;
  tone: Tone;
  leaving: boolean;
}

const SHOWN_MS = 3000;
const EXIT_MS = 160;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const update = (next: Toast[]) => {
  toasts = next;
  emit();
};

function dismiss(id: number) {
  update(toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
  setTimeout(() => update(toasts.filter((t) => t.id !== id)), EXIT_MS);
}

/** Shows a short message at the bottom right for three seconds. */
export function toast(message: string, tone: Tone = "positive") {
  const id = nextId++;
  // At most three at once; the oldest makes way.
  update([...toasts.slice(-2), { id, message, tone, leaving: false }]);
  setTimeout(() => dismiss(id), SHOWN_MS - EXIT_MS);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => toasts;
// The same empty list every time: React compares snapshots by identity.
const NONE: Toast[] = [];
const serverSnapshot = () => NONE;

/** Where toasts appear. Mounted once, in the root layout; announced politely to screen readers. */
export function Toaster() {
  const items = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 print:hidden"
    >
      {items.map((t) => {
        const Icon = t.tone === "positive" ? CircleCheck : CircleAlert;
        return (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex w-full items-center gap-2.5 rounded-lg border border-line bg-surface py-2.5 pr-2 pl-3.5 text-sm text-ink shadow-overlay sm:w-auto sm:max-w-sm",
              t.leaving ? "animate-fade-out" : "animate-toast-in",
            )}
          >
            <Icon
              aria-hidden="true"
              className={cn("size-4 shrink-0", t.tone === "positive" ? "text-positive" : "text-critical")}
            />
            <span className="min-w-0 flex-1">{t.message}</span>
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-subtle hover:text-ink"
            >
              <X aria-hidden="true" className="size-3.5" />
              <span className="sr-only">Dismiss</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Toasts a form's success message once per submission (or `fallback` when it has none); renders nothing. */
export function SuccessToast({ state, fallback }: { state: FormState<unknown>; fallback?: string }) {
  const shown = useRef<FormState<unknown> | null>(null);
  const message = state.message ?? fallback;
  useEffect(() => {
    if (state.status === "success" && message && shown.current !== state) {
      shown.current = state;
      toast(message);
    }
  }, [state, message]);
  return null;
}

/** A form's outcome: success as a toast, an error inline where the person is working. */
export function FormMessage({ state }: { state: FormState<unknown> }) {
  return (
    <>
      <SuccessToast state={state} />
      {state.status === "error" && state.message && <Alert tone="critical">{state.message}</Alert>}
    </>
  );
}
