import { cn } from "@/lib/cn";
import { initials } from "@/lib/format";

/** A school's mark until logo uploads exist. */
export function SchoolMonogram({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-ink font-display text-sm font-semibold text-white",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
