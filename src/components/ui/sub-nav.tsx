"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

/** Secondary navigation within a section, e.g. Settings → Profile / Campuses / Plan. */
export function SubNav({ label, items }: { label: string; items: { label: string; href: Route }[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="-mb-px flex gap-6 overflow-x-auto border-b border-line">
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "border-b-2 pb-2.5 text-base whitespace-nowrap transition-colors",
              active ? "border-ink font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
