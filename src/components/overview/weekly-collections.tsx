"use client";

import type { Route } from "next";
import Link from "next/link";
import { useState } from "react";
import { axisCedis, niceTicks } from "@/lib/dashboard";
import { formatCedis } from "@/lib/money";

export interface ChartWeek {
  from: string;
  to: string;
  /** "3 Nov – 9 Nov" */
  label: string;
  totalPesewas: number;
  /** The payments report for that week. */
  href: string;
}

/**
 * Money collected per week, as columns from one baseline. Each column links to that week's payments;
 * hovering or focusing it shows the amount, and the same figures are available as a table.
 */
export function WeeklyCollections({ weeks, caption }: { weeks: ChartWeek[]; caption: string }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(0, ...weeks.map((w) => w.totalPesewas));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const compact = top >= 1_000_000;
  const shown = active === null ? null : weeks[active];

  return (
    <figure className="space-y-3">
      <figcaption className="sr-only">{caption}</figcaption>
      <div className="flex gap-3">
        {/* Axis: clean ticks, recessive hairlines. */}
        <div
          aria-hidden="true"
          className="relative h-44 w-16 shrink-0 text-right text-xs text-ink-3 tabular-nums"
        >
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-0 whitespace-nowrap"
              style={{ bottom: `${(t / top) * 100}%`, transform: "translateY(50%)" }}
            >
              {axisCedis(t, compact)}
            </span>
          ))}
        </div>
        <div className="relative h-44 min-w-0 flex-1">
          {ticks.map((t) => (
            <span
              key={t}
              aria-hidden="true"
              className={`absolute inset-x-0 h-px ${t === 0 ? "bg-line-strong" : "bg-line"}`}
              style={{ bottom: `${(t / top) * 100}%` }}
            />
          ))}
          <ol className="absolute inset-0 flex items-end">
            {weeks.map((w, i) => (
              <li key={w.from} className="flex h-full min-w-0 flex-1 items-end justify-center">
                <Link
                  href={w.href as Route}
                  aria-label={`${w.label}: ${formatCedis(w.totalPesewas)}`}
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive((a) => (a === i ? null : a))}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive((a) => (a === i ? null : a))}
                  // The hit target is the whole column slot, wider and taller than the bar.
                  className="group flex h-full w-full items-end justify-center rounded-sm px-[1px] focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <span
                    className={`block w-full max-w-6 rounded-t-[4px] transition-opacity ${
                      active !== null && active !== i ? "bg-accent/45" : "bg-accent"
                    }`}
                    // A week with nothing collected still shows a hairline on the baseline.
                    style={{
                      height: w.totalPesewas > 0 ? `max(2px, ${(w.totalPesewas / top) * 100}%)` : "0",
                    }}
                  />
                </Link>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <div className="flex min-h-5 items-baseline justify-between gap-3 pl-[4.75rem] text-xs text-ink-3">
        {shown ? (
          <p aria-live="polite" className="text-sm text-ink-2">
            <span className="font-semibold text-ink">{formatCedis(shown.totalPesewas)}</span> in the week{" "}
            {shown.label}
          </p>
        ) : (
          <>
            <span>{weeks[0]?.label.split(" – ")[0]}</span>
            <span>{weeks[weeks.length - 1]?.label.split(" – ")[1]}</span>
          </>
        )}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-ink-2 hover:text-ink">Show as a table</summary>
        <table className="mt-2 w-full max-w-md text-left">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line text-ink-3">
              <th scope="col" className="py-1.5 font-medium">
                Week
              </th>
              <th scope="col" className="py-1.5 text-right font-medium">
                Collected
              </th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.from} className="border-b border-line last:border-0">
                <td className="py-1.5">
                  <Link href={w.href as Route} className="text-ink hover:text-accent hover:underline">
                    {w.label}
                  </Link>
                </td>
                <td className="py-1.5 text-right tabular-nums">{formatCedis(w.totalPesewas)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
