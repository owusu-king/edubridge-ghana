import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface FigureItem {
  label: string;
  value: ReactNode;
  /** The report the figure comes from. */
  href?: string;
  note?: ReactNode;
}

/** A row of headline figures, divided by hairlines (no cards). Each figure links to its report. */
export function Figures({ items, className }: { items: FigureItem[]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-2 border-y border-line lg:grid-cols-4", className)}>
      {items.map((item, i) => (
        <div
          key={item.label}
          className={cn(
            "min-w-0 border-line py-4 pr-4",
            i % 2 === 1 && "border-l pl-4",
            i > 1 && "border-t lg:border-t-0",
            i > 0 && "lg:border-l lg:pl-4",
          )}
        >
          <dt className="text-sm text-ink-3">{item.label}</dt>
          <dd className="mt-1">
            {item.href ? (
              <Link
                href={item.href as Route}
                className="font-display text-lg text-ink decoration-line-strong underline-offset-4 hover:text-accent hover:underline sm:text-xl"
              >
                {item.value}
              </Link>
            ) : (
              <span className="font-display text-lg text-ink sm:text-xl">{item.value}</span>
            )}
            {item.note && <p className="mt-1 text-sm text-ink-3">{item.note}</p>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
