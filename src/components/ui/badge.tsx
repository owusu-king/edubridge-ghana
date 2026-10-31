import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type Tone = "neutral" | "accent" | "positive" | "caution" | "critical";

const tones: Record<Tone, string> = {
  neutral: "bg-subtle text-ink-2 ring-line",
  accent: "bg-accent-soft text-accent ring-accent/15",
  positive: "bg-positive-soft text-positive ring-positive/15",
  caution: "bg-caution-soft text-caution ring-caution/15",
  critical: "bg-critical-soft text-critical ring-critical/15",
};

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-sm px-1.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A status with a coloured dot: quieter than a badge, for dense tables. */
export function StatusText({ tone, children }: { tone: Exclude<Tone, "accent">; children: ReactNode }) {
  const dot: Record<typeof tone, string> = {
    neutral: "bg-ink-3",
    positive: "bg-positive",
    caution: "bg-caution",
    critical: "bg-critical",
  };
  return (
    <span className="inline-flex items-center gap-2 text-ink-2">
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", dot[tone])} />
      {children}
    </span>
  );
}
