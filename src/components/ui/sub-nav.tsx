"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

/** Secondary navigation within a section, e.g. Settings → Profile / Campuses / Plan. */
export function SubNav({ label, items }: { label: string; items: { label: string; href: Route }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="flex gap-0.5 overflow-x-auto border-b border-line pb-1">
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-8 shrink-0 items-center rounded-md px-2.5 text-base whitespace-nowrap transition-colors",
              active ? "bg-subtle font-medium text-ink" : "text-ink-2 hover:bg-subtle/60 hover:text-ink",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
