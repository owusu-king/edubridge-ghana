"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { clampShare, LegendDot, RING_STROKE, type RingTone } from "./rings";

/*
 * Ring charts that respond to the pointer. Hovering a segment, a ring or its legend entry draws a soft halo
 * in that part's own colour around it and highlights its legend entry; nothing else changes, so every
 * figure stays at full strength. The donut's centre also shows the hovered part's figures. Everything
 * shown on hover is also in the legend, so nothing depends on it.
 */

/** The halo's fade; opacity only, so nothing moves. */
const HALO = "pointer-events-none transition-opacity duration-150 ease-out";

/** The hovered part's label, with handlers to set and clear it from any element that represents it. */
function useHighlight() {
  const [active, setActive] = useState<string | null>(null);
  const on = (key: string) => ({
    onPointerEnter: () => setActive(key),
    onPointerLeave: () => setActive((current) => (current === key ? null : current)),
  });
  return { active, on };
}

export interface DonutSegment {
  label: string;
  value: number;
  tone: RingTone;
}

/**
 * Parts of a whole as one ring, with the total in the centre and a legend beside it. `footer` closes the
 * legend (e.g. the total as a link).
 */
export function DonutBreakdown({
  segments,
  total,
  caption,
  label,
  footer,
}: {
  segments: DonutSegment[];
  total: number;
  /** A word or two under the total, e.g. "students". */
  caption: string;
  label: string;
  footer?: ReactNode;
}) {
  const { active, on } = useHighlight();
  const size = 112;
  const width = 10;
  const r = (size - width) / 2;
  const c = size / 2;
  const share = (n: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : "—");
  const shown = segments.filter((s) => s.value > 0);
  const gap = shown.length > 1 ? 1.2 : 0;
  let start = 0;
  const arcs =
    total > 0
      ? shown.map((s) => {
          const part = (s.value / total) * 100;
          const arc = { segment: s, length: Math.max(0, part - gap), offset: -(start + gap / 2) };
          start += part;
          return arc;
        })
      : [];
  const focus = segments.find((s) => s.label === active);
  return (
    <div className="flex items-center gap-6">
      <div
        className="relative size-28 shrink-0"
        role="img"
        aria-label={`${label}: ${total} ${caption}, ${segments.map((s) => `${s.label} ${s.value}`).join(", ")}`}
      >
        <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="size-full overflow-visible">
          <circle cx={c} cy={c} r={r} fill="none" strokeWidth={width} className="stroke-subtle" />
          <g transform={`rotate(-90 ${c} ${c})`}>
            {arcs.map(({ segment, length, offset }) => (
              <g key={segment.label}>
                {/* The halo: a wider, faint copy of the segment behind it, shown while it is hovered. */}
                <circle
                  cx={c}
                  cy={c}
                  r={r}
                  fill="none"
                  strokeWidth={width + 7}
                  pathLength={100}
                  strokeDasharray={`${length} ${100 - length}`}
                  strokeDashoffset={offset}
                  className={cn(
                    RING_STROKE[segment.tone],
                    HALO,
                    active === segment.label ? "opacity-20" : "opacity-0",
                  )}
                />
                <circle
                  {...on(segment.label)}
                  cx={c}
                  cy={c}
                  r={r}
                  fill="none"
                  strokeWidth={width}
                  pathLength={100}
                  strokeDasharray={`${length} ${100 - length}`}
                  strokeDashoffset={offset}
                  className={RING_STROKE[segment.tone]}
                />
              </g>
            ))}
          </g>
        </svg>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"
        >
          <span className="font-display text-xl leading-tight text-ink tabular-nums">
            {focus ? focus.value : total}
          </span>
          <span className="text-xs text-ink-3">
            {focus ? `${focus.label} · ${share(focus.value)}` : caption}
          </span>
        </span>
      </div>
      <dl className="min-w-0 flex-1 space-y-1">
        {segments.map((s) => (
          <div
            key={s.label}
            {...on(s.label)}
            className={cn(
              "-mx-2 flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors",
              active === s.label && "bg-subtle",
            )}
          >
            <LegendDot tone={s.tone} />
            <dt className="flex-1 text-ink-2">{s.label}</dt>
            <dd className="text-ink tabular-nums">
              {s.value}
              <span className="ml-2 inline-block w-9 text-right text-ink-3">{share(s.value)}</span>
            </dd>
          </div>
        ))}
        {footer}
      </dl>
    </div>
  );
}

export interface Ring {
  label: string;
  /** Out of 100. */
  value: number;
  /** The figure as shown, e.g. "68%". */
  display: string;
  detail?: ReactNode;
  tone: RingTone;
}

/** Concentric rings, one per share out of 100 (outermost first), with the figures beside them. */
export function ProgressRings({ rings, label }: { rings: Ring[]; label: string }) {
  const { active, on } = useHighlight();
  if (rings.length === 0) return null;
  const width = 8;
  const gap = 4;
  const outer = 56;
  const size = (outer + width / 2) * 2;
  const c = size / 2;
  return (
    <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:gap-10">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${label}: ${rings.map((r) => `${r.label} ${r.display}`).join(", ")}`}
        className="size-36 shrink-0 -rotate-90 overflow-visible"
      >
        {rings.map((ring, i) => {
          const r = outer - i * (width + gap);
          const value = clampShare(ring.value);
          return (
            <g key={ring.label} {...on(ring.label)}>
              <circle cx={c} cy={c} r={r} fill="none" strokeWidth={width} className="stroke-subtle" />
              {value > 0 && (
                <>
                  {/* The halo, reaching a little into the gaps either side, shown while it is hovered. */}
                  <circle
                    cx={c}
                    cy={c}
                    r={r}
                    fill="none"
                    strokeWidth={width + 5}
                    strokeLinecap="round"
                    pathLength={100}
                    strokeDasharray={`${value} 100`}
                    className={cn(
                      RING_STROKE[ring.tone],
                      HALO,
                      active === ring.label ? "opacity-20" : "opacity-0",
                    )}
                  />
                  <circle
                    cx={c}
                    cy={c}
                    r={r}
                    fill="none"
                    strokeWidth={width}
                    strokeLinecap="round"
                    pathLength={100}
                    strokeDasharray={`${value} 100`}
                    className={RING_STROKE[ring.tone]}
                  />
                </>
              )}
            </g>
          );
        })}
      </svg>
      <dl className="grid flex-1 gap-5 sm:auto-cols-fr sm:grid-flow-col sm:gap-0">
        {rings.map((ring, i) => (
          <div
            key={ring.label}
            {...on(ring.label)}
            className={cn("min-w-0", i > 0 && "sm:border-l sm:border-line sm:pl-6")}
          >
            <dt
              className={cn(
                "flex items-center gap-2 text-sm transition-colors",
                active === ring.label ? "text-ink" : "text-ink-3",
              )}
            >
              <LegendDot tone={ring.tone} />
              {ring.label}
            </dt>
            <dd className="mt-1">
              <span className="font-display text-xl text-ink tabular-nums">{ring.display}</span>
              {ring.detail && <p className="mt-1 text-sm text-ink-3">{ring.detail}</p>}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
