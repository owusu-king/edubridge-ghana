"use client";

import { CircleAlert, CircleCheck, X } from "lucide-react";
import { useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import type { FormState } from "@/web/forms";
import { Alert } from "./alert";
import { InDialog } from "./dialog";

/*
 * A form's outcome is never left as a message on the page: confirmations ("School profile saved.") and errors
 * ("Check the highlighted fields.", "This term is closed.") appear at the bottom right, confirmations for three
 * seconds and errors for six. What is wrong with a particular field stays under that field. No library: a tiny
 * store, and one <Toaster> mounted in the root layout.
 */

type Tone = "positive" | "critical";
interface Toast {
  id: number;
  message: string;
  tone: Tone;
  leaving: boolean;
}

const SHOWN_MS: Record<Tone, number> = { positive: 3000, critical: 6000 };
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

/** Shows a short message at the bottom right: three seconds, or six for an error. */
export function toast(message: string, tone: Tone = "positive", shownMs = SHOWN_MS[tone]) {
  const id = nextId++;
  // At most three at once; the oldest makes way.
  update([...toasts.slice(-2), { id, message, tone, leaving: false }]);
  setTimeout(() => dismiss(id), shownMs - EXIT_MS);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => toasts;
// The same empty list every time: React compares snapshots by identity.
const NONE: Toast[] = [];
const serverSnapshot = () => NONE;

/**
 * Where toasts appear. Mounted once, in the root layout. Confirmations and errors have a live region each, in
 * the page before any toast arrives, so screen readers announce confirmations politely and errors at once.
 */
export function Toaster() {
  const items = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-[60] flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 print:hidden">
      {(["positive", "critical"] as const).map((tone) => (
        <div
          key={tone}
          role={tone === "positive" ? "status" : "alert"}
          aria-live={tone === "positive" ? "polite" : "assertive"}
          className="flex w-full flex-col items-end gap-2 empty:hidden sm:w-auto"
        >
          {items
            .filter((t) => t.tone === tone)
            .map((t) => (
              <ToastItem key={t.id} toast={t} />
            ))}
        </div>
      ))}
    </div>
  );
}

function ToastItem({ toast: t }: { toast: Toast }) {
  const Icon = t.tone === "positive" ? CircleCheck : CircleAlert;
  return (
    <div
      className={cn(
        "pointer-events-auto flex w-full items-center gap-2.5 rounded-lg border bg-surface py-2.5 pr-2 pl-3.5 text-sm text-ink shadow-overlay sm:w-auto sm:max-w-sm",
        t.tone === "positive" ? "border-line" : "border-critical/30",
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

/**
 * A form's general error ("Check the highlighted fields.", or why it could not be saved), once per submission:
 * a toast on a page. Inside a dialog it is shown at the top of the dialog instead, and only when no field is
 * marked, since the marked fields already say what to fix. What is wrong with a field stays under that field.
 */
export function FormError({ state }: { state: FormState<unknown> }) {
  const inDialog = useContext(InDialog);
  const shown = useRef<FormState<unknown> | null>(null);
  useEffect(() => {
    if (!inDialog && state.status === "error" && state.message && shown.current !== state) {
      shown.current = state;
      toast(state.message, "critical");
    }
  }, [state, inDialog]);
  if (!inDialog || state.status !== "error" || !state.message) return null;
  if (Object.keys(state.fieldErrors ?? {}).length) return null;
  return <Alert tone="critical">{state.message}</Alert>;
}

/** A form's outcome: a confirmation toast, or its error (FormError). */
export function FormMessage({ state }: { state: FormState<unknown> }) {
  return (
    <>
      <SuccessToast state={state} />
      <FormError state={state} />
    </>
  );
}
