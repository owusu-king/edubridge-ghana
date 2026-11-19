import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { explicitTheme, THEME_COOKIE, type ThemeChoice } from "@/lib/theme";
import { ROLE_LABELS, ROLES } from "@/server/authz/permissions";
import { MobileNav } from "./mobile-nav";
import { ShellIdentity, SidebarFooter, UserMenu } from "./menus";
import { areaTitle, type ShellArea } from "./navigation";
import { SidebarNav } from "./sidebar-nav";

export interface AppShellProps {
  area: ShellArea;
  user: { name: string; email: string };
  isPlatformAdmin: boolean;
  signOut: () => Promise<void>;
  /** A line shown above every page, e.g. that this is a demonstration school. */
  notice?: ReactNode;
  children: ReactNode;
}

/** Desktop: fixed sidebar. Mobile: top bar with a navigation drawer. */
export async function AppShell({ area, user, isPlatformAdmin, signOut, notice, children }: AppShellProps) {
  const theme: ThemeChoice = explicitTheme((await cookies()).get(THEME_COOKIE)?.value) ?? "system";
  // Shown under the person's name in the profile menu: their roles here, in the usual order.
  const role =
    area.kind === "platform"
      ? "Platform administrator"
      : ROLES.filter((r) => area.roles.includes(r))
          .map((r) => ROLE_LABELS[r])
          .join(", ") || "Member";
  const menu = { name: user.name, role, signOut, isPlatformAdmin, theme };
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15.5rem_1fr] print:block">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-ink px-3 py-2 text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line bg-canvas px-3 py-3 lg:flex print:hidden">
        <ShellIdentity area={area} />
        {/* The scroll area reaches the sidebar edge so its scrollbar sits clear of the rows, never over them. */}
        <div className="mt-6 -mr-3 flex-1 [scrollbar-gutter:stable] overflow-y-auto overscroll-contain pr-2.5">
          <SidebarNav area={area} />
        </div>
        <div className="pt-3">
          <SidebarFooter {...menu} />
        </div>
      </aside>

      <div className="flex min-h-dvh min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-canvas/95 px-4 backdrop-blur lg:hidden print:hidden">
          <MobileNav area={area} />
          <span className="min-w-0 flex-1 truncate text-base font-semibold">{areaTitle(area)}</span>
          <UserMenu {...menu} compact />
        </header>
        {notice && (
          <div
            role="note"
            className="border-b border-caution/20 bg-caution-soft px-4 py-2 text-sm text-caution sm:px-6 lg:px-10 print:hidden"
          >
            {notice}
          </div>
        )}
        <main id="main" className="flex-1 bg-surface lg:min-h-dvh">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
