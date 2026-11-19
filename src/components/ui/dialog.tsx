"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Modal dialog for short, focused tasks (rename, confirm, a form). Controlled by the caller.
 * The title stays at the top and the `footer` (its actions) at the bottom; only the body scrolls when a
 * form is long, so the actions are always in reach and the dialog never grows past the screen.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  size = "md",
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** "lg" for forms that set fields side by side. */
  size?: "md" | "lg";
  /** The dialog's actions, kept in view below the scrolling body. */
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-ink/30 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in dark:bg-canvas/70" />
        <RadixDialog.Content
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[min(calc(100dvh-2rem),44rem)] -translate-x-1/2 -translate-y-1/2 flex-col",
            "overflow-hidden rounded-lg border border-line bg-surface shadow-overlay focus:outline-none",
            "data-[state=closed]:animate-fade-out data-[state=open]:animate-dialog-in",
            size === "lg" ? "w-[min(38rem,calc(100vw-2rem))]" : "w-[min(28rem,calc(100vw-2rem))]",
          )}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 px-5 pt-5 pb-4 sm:px-6 sm:pt-6">
            <div className="min-w-0">
              <RadixDialog.Title className="text-md font-semibold text-ink">{title}</RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="mt-1 text-sm text-ink-2">
                  {description}
                </RadixDialog.Description>
              ) : (
                <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close className="-mt-1 -mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-subtle hover:text-ink">
              <X aria-hidden="true" className="size-4" />
              <span className="sr-only">Close</span>
            </RadixDialog.Close>
          </div>
          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 sm:px-6",
              footer ? "pb-5" : "pb-5 sm:pb-6",
            )}
          >
            {children}
          </div>
          {footer && (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-4 sm:px-6">
              {footer}
            </div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
