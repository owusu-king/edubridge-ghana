import type { ReactNode } from "react";
import { MobileNav } from "./mobile-nav";
import { ShellIdentity, UserMenu } from "./menus";
import { areaTitle, type ShellArea } from "./navigation";
import { SidebarNav } from "./sidebar-nav";

export interface AppShellProps {
  area: ShellArea;
  user: { name: string; email: string };
  isPlatformAdmin: boolean;
  signOut: () => Promise<void>;
  /** A slim, persistent notice above the page (e.g. a required security step). */
  notice?: ReactNode;
  children: ReactNode;
}

/** Desktop: fixed sidebar. Mobile: top bar with a navigation drawer. */
export function AppShell({ area, user, isPlatformAdmin, signOut, notice, children }: AppShellProps) {
  const menu = { name: user.name, email: user.email, signOut, isPlatformAdmin };
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15.5rem_1fr]">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-ink px-3 py-2 text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>

      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line bg-canvas px-3 py-3 lg:flex">
        <ShellIdentity area={area} />
        <div className="mt-6 flex-1 overflow-y-auto">
          <SidebarNav area={area} />
        </div>
        <div className="border-t border-line pt-3">
          <UserMenu {...menu} />
        </div>
      </aside>

      <div className="flex min-h-dvh min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-canvas/95 px-4 backdrop-blur lg:hidden">
          <MobileNav area={area} />
          <span className="min-w-0 flex-1 truncate text-base font-semibold">{areaTitle(area)}</span>
          <UserMenu {...menu} compact />
        </header>
        <main id="main" className="flex-1 bg-surface lg:min-h-dvh">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8 lg:px-10 lg:py-10">
            {notice && <div className="mb-6">{notice}</div>}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
