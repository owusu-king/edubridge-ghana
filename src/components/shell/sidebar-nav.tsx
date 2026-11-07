"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { navLinks, type ShellArea } from "./navigation";

export function SidebarNav({ area, onNavigate }: { area: ShellArea; onNavigate?: () => void }) {
  const pathname = usePathname();
  const links = navLinks(area);
  const matches = (link: (typeof links)[number]) => {
    const base = link.activePrefix ?? link.href;
    return link.exact ? pathname === link.href : pathname === base || pathname.startsWith(`${base}/`);
  };
  // When links nest (/admin and /admin/billing), only the most specific match is current.
  const current = links
    .filter(matches)
    .sort((a, b) => (b.activePrefix ?? b.href).length - (a.activePrefix ?? a.href).length)[0];
  return (
    <nav aria-label={area.kind === "platform" ? "Platform" : "School"}>
      <ul className="space-y-0.5">
        {links.map(({ label, href, icon: Icon }) => {
          const active = current?.href === href;
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
