import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/*
 * Ring charts drawn as plain SVG (no chart library). Every figure a ring shows is also written out as
 * text beside it, so the rings summarise for the eye and never carry a value alone. The donut and the
 * concentric rings, which respond to hover, live in rings-interactive.tsx.
 */

export type RingTone = "accent" | "positive" | "caution" | "neutral";

export const RING_STROKE: Record<RingTone, string> = {
  accent: "stroke-accent",
  positive: "stroke-positive",
  caution: "stroke-caution",
  neutral: "stroke-ink-2",
};
const DOT: Record<RingTone, string> = {
  accent: "bg-accent",
  positive: "bg-positive",
  caution: "bg-caution",
  neutral: "bg-ink-2",
};
const TEXT: Record<RingTone, string> = {
  accent: "text-accent",
  positive: "text-positive",
  caution: "text-caution",
  neutral: "text-ink",
};

export const clampShare = (value: number) => Math.max(0, Math.min(100, value));

/** A small coloured dot that ties a legend entry to its ring or segment. */
export function LegendDot({ tone }: { tone: RingTone }) {
  return <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", DOT[tone])} />;
}

/**
 * One share out of 100 as a ring, with its figure in the centre. With no value it draws a dashed empty
 * circle (and `empty` inside it), for "nothing to measure yet".
 */
export function ScoreRing({
  value,
  display,
  label,
  tone = "accent",
  empty,
}: {
  value: number | null;
  /** The figure in the centre, e.g. "96%" or "3/8". */
  display: string;
  /** What the ring measures, for assistive technology. */
  label: string;
  tone?: RingTone;
  /** Shown inside the dashed circle when there is no value. */
  empty?: ReactNode;
}) {
  const size = 80;
  const width = 6;
  const r = (size - width) / 2;
  const c = size / 2;
  if (value === null) {
    return (
      <div className="relative size-20 shrink-0" role="img" aria-label={`${label}: none`}>
        <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="size-full">
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            strokeWidth={1.5}
            strokeDasharray="3 4"
            className="stroke-line-strong"
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-ink-3 [&_svg]:size-5">
          {empty}
        </span>
      </div>
    );
  }
  return (
    <div className="relative size-20 shrink-0" role="img" aria-label={`${label}: ${display}`}>
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="size-full">
        <circle cx={c} cy={c} r={r} fill="none" strokeWidth={width} className="stroke-subtle" />
        {clampShare(value) > 0 && (
          <circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            strokeWidth={width}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${clampShare(value)} 100`}
            transform={`rotate(-90 ${c} ${c})`}
            className={RING_STROKE[tone]}
          />
        )}
      </svg>
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-0 flex items-center justify-center font-display text-lg tabular-nums",
          TEXT[tone],
        )}
      >
        {display}
      </span>
    </div>
  );
}
