"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import type { Role } from "@/server/authz/permissions";
import { cn } from "@/lib/cn";
import { navHref, visibleNavItems } from "./navigation";

export function SidebarNav({
  slug,
  roles,
  onNavigate,
}: {
  slug: string;
  roles: Role[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const items = visibleNavItems(roles);
  return (
    <nav aria-label="School">
      <ul className="space-y-0.5">
        {items.map(({ label, segment, icon: Icon }) => {
          const href = navHref(slug, segment);
          const active = segment ? pathname === href || pathname.startsWith(`${href}/`) : pathname === href;
          return (
            <li key={label}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-base transition-colors",
                  active
                    ? "bg-surface font-medium text-ink shadow-raised ring-1 ring-line"
                    : "text-ink-2 hover:bg-subtle hover:text-ink",
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn("size-4", active ? "text-ink" : "text-ink-3")}
                  strokeWidth={1.75}
                />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
