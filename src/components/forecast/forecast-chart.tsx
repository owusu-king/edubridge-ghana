"use client";

import { useState } from "react";
import { axisCedis, niceTicks } from "@/lib/dashboard";
import { formatMoney } from "@/lib/money";

export interface ForecastChartWeek {
  from: string;
  /** "3 Nov – 9 Nov" */
  label: string;
  /** Collected in the week so far; null before it starts. */
  actualPesewas: number | null;
  /** Expected in the rest of the week; null once it is over. */
  likelyPesewas: number | null;
  lowPesewas: number | null;
  highPesewas: number | null;
}

/**
 * Money collected and expected per week (FCT-01), as columns from one baseline in one hue: collected weeks solid,
 * forecast weeks light with a dashed outline (so the two differ by more than colour), the range a thin whisker.
 * Hovering or focusing a week shows its figures; the page's table has the same figures.
 */
export function ForecastChart({
  currency,
  weeks,
  caption,
}: {
  currency: string;
  weeks: ForecastChartWeek[];
  caption: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(
    0,
    ...weeks.map((w) => (w.actualPesewas ?? 0) + (w.highPesewas ?? w.likelyPesewas ?? 0)),
  );
  const ticks = niceTicks(max, 4, currency);
  const top = ticks[ticks.length - 1] || 1;
  const compact = top >= 1_000_000;
  const pct = (minor: number) => `${(minor / top) * 100}%`;
  const money = (minor: number) => formatMoney(minor, currency);
  const describe = (w: ForecastChartWeek) =>
    [
      w.actualPesewas !== null ? `${money(w.actualPesewas)} collected` : null,
      w.likelyPesewas !== null
        ? `${money(w.likelyPesewas)} expected (forecast, ${money(w.lowPesewas ?? 0)} to ${money(w.highPesewas ?? 0)})`
        : null,
    ]
      .filter(Boolean)
      .join(", ");
  const shown = active === null ? null : weeks[active];

  return (
    <figure className="space-y-3">
      <figcaption className="sr-only">{caption}</figcaption>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-ink-2" aria-hidden="true">
        <span className="inline-flex items-center gap-2">
          <span className="size-3 rounded-[3px] bg-accent" />
          Collected
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="size-3 rounded-[3px] border border-dashed border-accent bg-accent/20" />
          Forecast, likely
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-3 w-px bg-ink-2" />
          Forecast range
        </span>
      </div>
      <div className="flex gap-3">
        <div
          aria-hidden="true"
          className="relative h-48 w-16 shrink-0 text-right text-xs text-ink-3 tabular-nums"
        >
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-0 whitespace-nowrap"
              style={{ bottom: pct(t), transform: "translateY(50%)" }}
            >
              {axisCedis(t, compact, currency)}
            </span>
          ))}
        </div>
        <div className="relative h-48 min-w-0 flex-1">
          {ticks.map((t) => (
            <span
              key={t}
              aria-hidden="true"
              className={`absolute inset-x-0 h-px ${t === 0 ? "bg-line-strong" : "bg-line/60"}`}
              style={{ bottom: pct(t) }}
            />
          ))}
          <ol className="absolute inset-0 flex items-end">
            {weeks.map((w, i) => {
              const actual = w.actualPesewas ?? 0;
              const dim = active !== null && active !== i;
              return (
                <li
                  key={w.from}
                  tabIndex={0}
                  aria-label={`${w.label}: ${describe(w)}`}
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive((a) => (a === i ? null : a))}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive((a) => (a === i ? null : a))}
                  // The hit target is the whole column slot, wider and taller than the marks.
                  className="relative flex h-full min-w-0 flex-1 flex-col items-center justify-end rounded-sm px-[1px] outline-none focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {w.likelyPesewas !== null && w.highPesewas !== null && w.highPesewas > 0 && (
                    <span
                      aria-hidden="true"
                      className={`absolute w-px ${dim ? "bg-ink-3/40" : "bg-ink-2"}`}
                      style={{
                        bottom: pct(actual + (w.lowPesewas ?? 0)),
                        height: `max(1px, ${pct((w.highPesewas ?? 0) - (w.lowPesewas ?? 0))})`,
                      }}
                    />
                  )}
                  {w.likelyPesewas !== null && w.likelyPesewas > 0 && (
                    <span
                      aria-hidden="true"
                      className={`block w-full max-w-6 rounded-t-[4px] border border-b-0 border-dashed border-accent ${
                        dim ? "bg-accent/10" : "bg-accent/20"
                      } ${actual > 0 ? "mb-[2px]" : ""}`}
                      style={{ height: `max(2px, ${pct(w.likelyPesewas)})` }}
                    />
                  )}
                  {actual > 0 && (
                    <span
                      aria-hidden="true"
                      className={`block w-full max-w-6 ${
                        w.likelyPesewas ? "" : "rounded-t-[4px]"
                      } ${dim ? "bg-accent/35" : "bg-accent"}`}
                      style={{ height: `max(2px, ${pct(actual)})` }}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      <div className="flex min-h-5 items-baseline justify-between gap-3 pl-[4.75rem] text-xs text-ink-3">
        {shown ? (
          <p aria-live="polite" className="text-sm text-ink-2">
            <span className="font-semibold text-ink">{shown.label}</span>: {describe(shown)}
          </p>
        ) : (
          <>
            <span>{weeks[0]?.label.split(" – ")[0]}</span>
            <span>{weeks[weeks.length - 1]?.label.split(" – ")[1]}</span>
          </>
        )}
      </div>
    </figure>
  );
}
