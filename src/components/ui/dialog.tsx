"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

/** Modal dialog for short, focused tasks (rename, confirm). Controlled by the caller. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  size = "md",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** "lg" for forms with a grid of inputs. */
  size?: "md" | "lg";
  children: ReactNode;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-ink/30" />
        <RadixDialog.Content
          className={`fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] ${size === "lg" ? "w-[min(44rem,calc(100vw-2rem))]" : "w-[min(28rem,calc(100vw-2rem))]"} -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain rounded-lg border border-line bg-surface p-5 shadow-overlay focus:outline-none sm:p-6`}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <RadixDialog.Title className="text-md font-semibold text-ink">{title}</RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="mt-1 text-base text-ink-2">
                  {description}
                </RadixDialog.Description>
              ) : (
                <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close className="-mt-1 -mr-1 inline-flex size-8 items-center justify-center rounded-md text-ink-3 hover:bg-subtle hover:text-ink">
              <X aria-hidden="true" className="size-4" />
              <span className="sr-only">Close</span>
            </RadixDialog.Close>
          </div>
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
