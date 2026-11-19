"use client";

import { Plane } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId } from "react";
import { cn } from "@/lib/cn";
import { navLinks, type NavLink, type ShellArea } from "./navigation";

/** Leave's plane takes off and lands when its row is hovered or reached by keyboard (globals.css). */
const FLY = "group-hover:animate-icon-fly group-focus-visible:animate-icon-fly";

export function SidebarNav({ area, onNavigate }: { area: ShellArea; onNavigate?: () => void }) {
  const pathname = usePathname();
  // The sidebar and the mobile drawer can both be in the page, so section label ids are made unique.
  const id = useId();
  const links = navLinks(area);
  const matches = (link: NavLink) => {
    const base = link.activePrefix ?? link.href;
    return link.exact ? pathname === link.href : pathname === base || pathname.startsWith(`${base}/`);
  };
  // When links nest (/admin and /admin/billing), only the most specific match is current.
  const current = links
    .filter(matches)
    .sort((a, b) => (b.activePrefix ?? b.href).length - (a.activePrefix ?? a.href).length)[0];
  // Consecutive links that share a section form one labelled group; links without a section lead.
  const groups: { section?: string; links: NavLink[] }[] = [];
  for (const link of links) {
    const last = groups[groups.length - 1];
    if (last && last.section === link.section) last.links.push(link);
    else groups.push({ section: link.section, links: [link] });
  }
  return (
    <nav aria-label={area.kind === "platform" ? "Platform" : "School"} className="space-y-5">
      {groups.map((group) => {
        const labelId = group.section ? `${id}-${group.section}` : undefined;
        return (
          <div key={group.section ?? "main"}>
            {group.section && (
              <p id={labelId} className="mb-1 px-2.5 text-xs leading-5 font-medium text-ink-3">
                {group.section}
              </p>
            )}
            <ul className="space-y-0.5" aria-labelledby={labelId}>
              {group.links.map(({ label, href, icon: Icon }) => {
                const active = current?.href === href;
                return (
                  <li key={label}>
                    <Link
                      href={href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group flex h-9 items-center gap-2.5 rounded-md px-2.5 text-base leading-none font-medium transition-colors",
                        active
                          ? "bg-accent-soft/60 text-accent"
                          : "text-ink-2 hover:bg-subtle hover:text-ink",
                      )}
                    >
                      <Icon
                        aria-hidden="true"
                        className={cn(
                          "size-4 shrink-0 transition-colors",
                          Icon === Plane && FLY,
                          active ? "text-accent" : "text-ink-3 group-hover:text-ink-2",
                        )}
                        strokeWidth={1.75}
                      />
                      <span className="min-w-0 truncate">{label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
