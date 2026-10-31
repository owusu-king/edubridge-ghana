"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronsUpDown, LogOut } from "lucide-react";
import Link from "next/link";
import { useRef } from "react";
import type { Route } from "next";
import { Avatar } from "@/components/ui/layout";
import { SchoolMonogram } from "@/components/ui/monogram";
import { initials } from "@/lib/format";
import { schoolPath } from "@/lib/routes";

const menuContent =
  "z-50 min-w-60 overflow-hidden rounded-lg border border-line bg-surface p-1 text-base shadow-overlay";
const menuItem =
  "flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-ink-2 outline-none select-none " +
  "data-[highlighted]:bg-subtle data-[highlighted]:text-ink";

export interface SchoolOption {
  slug: string;
  name: string;
}

export function SchoolSwitcher({ current, schools }: { current: SchoolOption; schools: SchoolOption[] }) {
  const identity = (
    <>
      <SchoolMonogram name={current.name} />
      <span className="line-clamp-2 min-w-0 flex-1 text-left text-sm leading-snug font-semibold text-ink">
        {current.name}
      </span>
    </>
  );
  if (schools.length <= 1) return <div className="flex items-center gap-2.5 px-1.5 py-1">{identity}</div>;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1 transition-colors hover:bg-subtle"
        aria-label={`Current school: ${current.name}. Switch school`}
      >
        {identity}
        <ChevronsUpDown aria-hidden="true" className="size-4 text-ink-3" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className={menuContent}>
          <DropdownMenu.Label className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-ink-3">
            Your schools
          </DropdownMenu.Label>
          {schools.map((school) => (
            <DropdownMenu.Item key={school.slug} asChild className={menuItem}>
              <Link href={schoolPath(school.slug)}>
                <SchoolMonogram name={school.name} className="size-6 rounded-sm text-xs" />
                <span className="flex-1 truncate">{school.name}</span>
                {school.slug === current.slug && <Check aria-label="Current" className="size-4 text-ink" />}
              </Link>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function UserMenu({
  name,
  email,
  signOut,
  compact = false,
}: {
  name: string;
  email: string;
  signOut: () => Promise<void>;
  compact?: boolean;
}) {
  // The form lives outside the menu: Radix unmounts menu content on select, before a nested form submits.
  const signOutForm = useRef<HTMLFormElement>(null);
  return (
    <DropdownMenu.Root>
      <form ref={signOutForm} action={signOut} hidden />
      <DropdownMenu.Trigger
        aria-label={`Account: ${name}`}
        className={
          compact
            ? "rounded-full"
            : "flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-subtle"
        }
      >
        <Avatar label={name} initials={initials(name)} />
        {!compact && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-ink">{name}</span>
            <span className="block truncate text-xs text-ink-3">{email}</span>
          </span>
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={compact ? "end" : "start"}
          side={compact ? "bottom" : "top"}
          sideOffset={6}
          className={menuContent}
        >
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-medium text-ink">{name}</p>
            <p className="truncate text-xs text-ink-3">{email}</p>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item asChild className={menuItem}>
            <Link href="/schools">All schools</Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItem} onSelect={() => signOutForm.current?.requestSubmit()}>
            <LogOut aria-hidden="true" className="size-4" />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
