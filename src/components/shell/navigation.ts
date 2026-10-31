import type { Route } from "next";
import { Building2, LayoutGrid, School, Settings, Users, type LucideIcon } from "lucide-react";
import { can, type Permission, type Role } from "@/server/authz/permissions";
import { schoolPath } from "@/lib/routes";

export interface SchoolOption {
  slug: string;
  name: string;
}

/** Which part of the product the shell is framing. Serializable, so it can cross to client components. */
export type ShellArea =
  { kind: "school"; school: SchoolOption; schools: SchoolOption[]; roles: Role[] } | { kind: "platform" };

export interface NavLink {
  label: string;
  href: Route;
  icon: LucideIcon;
  /** Match only the exact path, not sub-paths (for section roots). */
  exact?: boolean;
  /** Treat any path under this prefix as active (when the link opens a sub-page). */
  activePrefix?: Route;
}

/** Settings tabs, each shown only to roles that may use it. The first visible tab is the Settings landing page. */
const SETTINGS_TABS: readonly { label: string; segment: string; permission: Permission }[] = [
  { label: "Profile", segment: "settings", permission: "school.settings.manage" },
  { label: "Calendar", segment: "settings/calendar", permission: "academics.manage" },
  { label: "Campuses", segment: "settings/campuses", permission: "campuses.manage" },
  { label: "Plan", segment: "settings/plan", permission: "plan.view" },
  { label: "Security", segment: "settings/security", permission: "security.manage" },
  { label: "Audit log", segment: "settings/audit", permission: "audit.view" },
];

export function settingsTabs(slug: string, roles: readonly Role[]): { label: string; href: Route }[] {
  return SETTINGS_TABS.filter((t) => can(roles, t.permission)).map((t) => ({
    label: t.label,
    href: schoolPath(slug, t.segment),
  }));
}

/** Only modules that actually exist appear here. Nothing is shown as available before it works. */
const SCHOOL_NAV: readonly { label: string; segment: string; icon: LucideIcon; permission: Permission }[] = [
  { label: "Overview", segment: "", icon: LayoutGrid, permission: "school.view" },
  { label: "Classes", segment: "classes", icon: School, permission: "classes.view" },
  { label: "Members", segment: "members", icon: Users, permission: "members.view" },
];

export function navLinks(area: ShellArea): NavLink[] {
  if (area.kind === "platform") {
    return [{ label: "Schools", href: "/admin" as Route, icon: Building2 }];
  }
  const links: NavLink[] = SCHOOL_NAV.filter((item) => can(area.roles, item.permission)).map((item) => ({
    label: item.label,
    href: schoolPath(area.school.slug, item.segment),
    icon: item.icon,
    exact: item.segment === "",
  }));
  const [firstTab] = settingsTabs(area.school.slug, area.roles);
  // Highlight Settings for every settings tab, whichever one it opens on.
  if (firstTab)
    links.push({
      label: "Settings",
      href: firstTab.href,
      icon: Settings,
      activePrefix: schoolPath(area.school.slug, "settings"),
    });
  return links;
}

export function areaTitle(area: ShellArea): string {
  return area.kind === "platform" ? "EduBridge Platform" : area.school.name;
}
