"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Building2,
  Check,
  ChevronsUpDown,
  LogOut,
  Monitor,
  MonitorDown,
  Moon,
  Sun,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Avatar } from "@/components/ui/layout";
import { SchoolMonogram } from "@/components/ui/monogram";
import { menuContent, menuItem, menuItemDanger, useFocusReturn } from "@/components/ui/menu";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/format";
import { THEME_CANVAS, THEME_COOKIE, type ThemeChoice } from "@/lib/theme";
import { Wordmark } from "@/components/ui/wordmark";
import type { SchoolOption, ShellArea } from "./navigation";
import { schoolPath } from "@/lib/routes";
import { clearOfflineData } from "@/components/attendance/offline";
import { toast } from "@/components/ui/toast";
import { INSTALL_HELP, promptInstall, useInstall } from "./install";

export function SchoolSwitcher({ current, schools }: { current: SchoolOption; schools: SchoolOption[] }) {
  const identity = (
    <>
      {current.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- the school's own logo
        <img src={current.logoUrl} alt="" className="size-8 shrink-0 rounded-md object-contain" />
      ) : (
        <SchoolMonogram name={current.name} />
      )}
      <span className="line-clamp-2 min-w-0 flex-1 text-left text-sm leading-snug font-semibold text-ink">
        {current.name}
      </span>
    </>
  );
  const focus = useFocusReturn();
  if (schools.length <= 1) return <div className="flex items-center gap-2.5 px-1.5 py-1">{identity}</div>;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        {...focus.trigger}
        className="flex w-full items-center gap-2.5 rounded-md px-1.5 py-1 transition-colors hover:bg-subtle"
        aria-label={`Current school: ${current.name}. Switch school`}
      >
        {identity}
        <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-ink-3" strokeWidth={1.75} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content {...focus.content} align="start" sideOffset={6} className={menuContent}>
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

const THEMES: { value: ThemeChoice; label: string; Icon: LucideIcon }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

/**
 * The person's theme. Applied to <html> at once and kept in a cookie for a year, then the page is refreshed
 * so the server-rendered <html> agrees with it. "System" removes the cookie and follows the device again.
 */
function useThemeChoice(initial: ThemeChoice) {
  const router = useRouter();
  const [theme, setTheme] = useState(initial);
  function choose(value: string) {
    const next = (THEMES.find((t) => t.value === value) ?? THEMES[0]!).value;
    setTheme(next);
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    if (next === "system") {
      document.cookie = `${THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
      delete document.documentElement.dataset.theme;
    } else {
      document.cookie = `${THEME_COOKIE}=${next}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
      document.documentElement.dataset.theme = next;
    }
    paintThemeColor(next);
    router.refresh();
  }
  return [theme, choose] as const;
}

/**
 * The browser's (and an installed window's) title-bar colour, changed in the same moment as the page. Otherwise it
 * waits for the server's refresh, which writes the same colour a moment later. Every theme-colour tag gets the new
 * colour, whichever device setting it was written for.
 */
function paintThemeColor(choice: ThemeChoice) {
  const deviceDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const media = meta.getAttribute("media") ?? "";
    const scheme =
      choice !== "system"
        ? choice
        : media.includes("dark")
          ? "dark"
          : media.includes("light")
            ? "light"
            : deviceDark
              ? "dark"
              : "light";
    meta.content = THEME_CANVAS[scheme];
  }
}

function ThemeItems({ theme, onChoose }: { theme: ThemeChoice; onChoose: (value: string) => void }) {
  return (
    <DropdownMenu.RadioGroup value={theme} onValueChange={onChoose}>
      {THEMES.map(({ value, label, Icon }) => (
        <DropdownMenu.RadioItem key={value} value={value} className={menuItem}>
          <Icon aria-hidden="true" className="size-4" strokeWidth={1.75} />
          <span className="flex-1">{label}</span>
          <DropdownMenu.ItemIndicator>
            <Check aria-hidden="true" className="size-4 text-ink" />
          </DropdownMenu.ItemIndicator>
        </DropdownMenu.RadioItem>
      ))}
    </DropdownMenu.RadioGroup>
  );
}

const iconButton =
  "inline-flex size-9 items-center justify-center rounded-lg text-ink-2 transition-colors " +
  "hover:bg-subtle hover:text-ink data-[state=open]:bg-subtle data-[state=open]:text-ink [&_svg]:size-4";

/** Choosing System, Light or Dark (the sidebar's bottom-left button). */
export function ThemeMenu({ theme: initial }: { theme: ThemeChoice }) {
  const [theme, choose] = useThemeChoice(initial);
  const { Icon, label } = THEMES.find((t) => t.value === theme) ?? THEMES[0]!;
  const focus = useFocusReturn();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        {...focus.trigger}
        aria-label={`Theme: ${label}`}
        title="Theme"
        className={`${iconButton} bg-subtle text-ink ring-1 ring-line ring-inset`}
      >
        <Icon aria-hidden="true" strokeWidth={1.75} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...focus.content}
          side="top"
          align="start"
          sideOffset={6}
          className={`${menuContent} min-w-40`}
        >
          <ThemeItems theme={theme} onChoose={choose} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

interface UserMenuProps {
  name: string;
  /** The person's role in this area, e.g. "Proprietor" (shown under their name). */
  role: string;
  signOut: () => Promise<void>;
  isPlatformAdmin?: boolean;
  theme: ThemeChoice;
  /** The mobile top bar: an avatar, with All schools and the theme inside the menu. */
  compact?: boolean;
}

export function UserMenu({
  name,
  role,
  signOut,
  isPlatformAdmin = false,
  theme: initialTheme,
  compact = false,
}: UserMenuProps) {
  // The form lives outside the menu: Radix unmounts menu content on select, before a nested form submits.
  const signOutForm = useRef<HTMLFormElement>(null);
  const [theme, chooseTheme] = useThemeChoice(initialTheme);
  const focus = useFocusReturn();
  const install = useInstall();
  // On the account pages the profile button shows as the current place, like a sidebar link.
  const onAccount = usePathname().startsWith("/account");
  return (
    <DropdownMenu.Root>
      <form ref={signOutForm} action={signOut} hidden />
      <DropdownMenu.Trigger
        {...focus.trigger}
        aria-label={`Profile: ${name}`}
        title={compact ? undefined : "Profile"}
        aria-current={onAccount ? "page" : undefined}
        className={compact ? "rounded-full" : cn(iconButton, onAccount && "bg-accent-soft/60 text-accent")}
      >
        {compact ? (
          <Avatar label={name} initials={initials(name)} />
        ) : (
          <UserRound aria-hidden="true" strokeWidth={1.75} />
        )}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...focus.content}
          align={compact ? "end" : "start"}
          side={compact ? "bottom" : "top"}
          sideOffset={6}
          className={`${menuContent} max-w-64`}
        >
          <div className="flex items-center gap-2.5 px-2.5 py-2">
            <Avatar label={name} initials={initials(name)} size="sm" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{name}</p>
              <p className="truncate text-xs text-ink-3">{role}</p>
            </div>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item asChild className={menuItem}>
            <Link href="/account">Your account</Link>
          </DropdownMenu.Item>
          {compact && (
            <DropdownMenu.Item asChild className={menuItem}>
              <Link href="/schools">All schools</Link>
            </DropdownMenu.Item>
          )}
          {isPlatformAdmin && (
            <DropdownMenu.Item asChild className={menuItem}>
              <Link href="/admin">Platform administration</Link>
            </DropdownMenu.Item>
          )}
          {compact && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <DropdownMenu.Label className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-ink-3">
                Theme
              </DropdownMenu.Label>
              <ThemeItems theme={theme} onChoose={chooseTheme} />
            </>
          )}
          {install && (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-line" />
              <DropdownMenu.Item
                className={menuItem}
                onSelect={() => {
                  if (install === "prompt") {
                    void promptInstall().then((done) => {
                      if (done)
                        toast("EduBridge is installed. Open it from your Start menu, Dock or home screen.");
                    });
                  } else toast(INSTALL_HELP[install], "positive", 10_000);
                }}
              >
                <MonitorDown aria-hidden="true" className="size-4" />
                Install EduBridge
              </DropdownMenu.Item>
            </>
          )}
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item
            className={menuItemDanger}
            onSelect={() => void clearOfflineData().finally(() => signOutForm.current?.requestSubmit())}
          >
            <LogOut aria-hidden="true" className="size-4" />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The bottom of the sidebar: the theme on the left, the profile menu and all schools on the right. */
export function SidebarFooter(props: Omit<UserMenuProps, "compact">) {
  return (
    <div className="flex items-center gap-1">
      <ThemeMenu theme={props.theme} />
      <span className="flex-1" />
      <UserMenu {...props} />
      <Link href="/schools" aria-label="All schools" title="All schools" className={iconButton}>
        <Building2 aria-hidden="true" strokeWidth={1.75} />
      </Link>
    </div>
  );
}

/** Top-left identity: the school (with switcher) or the platform. */
export function ShellIdentity({ area }: { area: ShellArea }) {
  if (area.kind === "platform") {
    return (
      <div className="flex items-center justify-between gap-2 px-1.5 py-1">
        <Wordmark />
        <span className="text-xs font-medium tracking-wide text-ink-3 uppercase">Platform</span>
      </div>
    );
  }
  return <SchoolSwitcher current={area.school} schools={area.schools} />;
}
