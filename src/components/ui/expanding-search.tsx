"use client";

import { Search } from "lucide-react";
import { useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * A search that waits as an icon and, when clicked, widens smoothly into a search box. Placed at the right of
 * a toolbar, it grows to the left. It starts open when a search is active, and folds back to the icon when it
 * is left empty (click away, or Escape).
 *
 * `form` ties the box to the page's filter form by its id, so Enter searches with the other filters applied,
 * wherever the box sits on the page.
 */
export function ExpandingSearch({
  form,
  name = "q",
  defaultValue,
  placeholder,
  label,
  buttonLabel,
}: {
  form: string;
  name?: string;
  defaultValue?: string;
  placeholder: string;
  /** The box's name for assistive technology, e.g. "Search by name or admission number". */
  label: string;
  /** The icon button's name, e.g. "Find students" (kept distinct from the page's own Search button). */
  buttonLabel: string;
}) {
  const [open, setOpen] = useState(Boolean(defaultValue));
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div
      className={cn(
        "relative h-10 shrink-0 overflow-hidden rounded-md border border-line-strong bg-surface dark:bg-subtle/60",
        "transition-[width,border-color,box-shadow,background-color] duration-300 ease-out",
        "focus-within:border-accent focus-within:shadow-[inset_0_0_0_1px_var(--color-accent)]",
        open ? "w-[min(18rem,calc(100vw-2rem))]" : "w-10 hover:border-ink-3/60 hover:bg-subtle",
      )}
    >
      <button
        ref={button}
        type="button"
        aria-label={buttonLabel}
        aria-expanded={open}
        tabIndex={open ? -1 : 0}
        onClick={() => {
          setOpen(true);
          // Focus once the box has started to open, so typing can begin at once.
          requestAnimationFrame(() => input.current?.focus());
        }}
        className={cn(
          "absolute inset-y-0 left-0 z-10 flex w-10 items-center justify-center text-ink-3 transition-colors",
          open ? "pointer-events-none" : "hover:text-ink",
        )}
      >
        <Search aria-hidden="true" className="size-4" strokeWidth={1.75} />
      </button>
      <input
        ref={input}
        form={form}
        name={name}
        type="search"
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-label={label}
        tabIndex={open ? 0 : -1}
        onBlur={(e) => {
          if (!e.currentTarget.value.trim()) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.currentTarget.value) {
            setOpen(false);
            button.current?.focus();
          }
        }}
        className={cn(
          "h-full w-full min-w-0 bg-transparent pr-3 pl-10 text-md text-ink outline-none placeholder:text-ink-3 sm:text-base",
          "transition-opacity duration-200",
          open ? "opacity-100 delay-75" : "pointer-events-none opacity-0",
        )}
      />
    </div>
  );
}
