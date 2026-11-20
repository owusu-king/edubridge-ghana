"use client";

import { useRef } from "react";

/** The look shared by every dropdown menu (sidebar menus, "More" menus). */
export const menuContent =
  "z-50 min-w-60 origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden rounded-lg border " +
  "border-line bg-surface p-1 text-base shadow-overlay data-[state=closed]:animate-fade-out " +
  "data-[state=open]:animate-menu-in";
export const menuItem =
  "flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-ink-2 transition-colors outline-none select-none " +
  "data-[highlighted]:bg-subtle data-[highlighted]:text-ink";

/** A menu item that ends or removes something (Sign out): red, with a pale red highlight. */
export const menuItemDanger =
  "flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-critical transition-colors outline-none select-none " +
  "data-[highlighted]:bg-critical-soft data-[highlighted]:text-critical";

/**
 * A menu opened or closed with the mouse does not hand focus back to its button: the browser would show the
 * keyboard focus ring there after a plain click. Keyboard use (Enter to open, Escape to close) still returns
 * focus to the button, ring and all, as it should. Spread `trigger` on the Trigger and `content` on the Content.
 */
export function useFocusReturn() {
  const byPointer = useRef(false);
  const keyboard = () => {
    byPointer.current = false;
  };
  return {
    trigger: {
      onPointerDown: () => {
        byPointer.current = true;
      },
      onKeyDown: keyboard,
    },
    content: {
      onKeyDown: keyboard,
      onCloseAutoFocus: (event: Event) => {
        if (byPointer.current) event.preventDefault();
        byPointer.current = false;
      },
    },
  };
}
