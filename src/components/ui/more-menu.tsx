"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronDown } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { buttonStyles } from "./button";
import { menuContent, menuItem, useFocusReturn } from "./menu";

/** A page's less frequent actions behind one quiet "More" button, so its header keeps one main action. */
export function MoreMenu({
  items,
  label = "More",
}: {
  items: { label: string; href: string }[];
  label?: string;
}) {
  const focus = useFocusReturn();
  if (items.length === 0) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger {...focus.trigger} className={buttonStyles("secondary")}>
        {label}
        <ChevronDown aria-hidden="true" className="text-ink-3" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...focus.content}
          align="end"
          sideOffset={6}
          className={`${menuContent} min-w-48`}
        >
          {items.map((item) => (
            <DropdownMenu.Item key={item.href} asChild className={menuItem}>
              <Link href={item.href as Route}>{item.label}</Link>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
