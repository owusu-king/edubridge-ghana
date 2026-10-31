import type { Route } from "next";
import { Building2, LayoutGrid, Settings, Users, type LucideIcon } from "lucide-react";
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
}

/** Only modules that actually exist appear here. Nothing is shown as available before it works. */
const SCHOOL_NAV: readonly { label: string; segment: string; icon: LucideIcon; permission: Permission }[] = [
  { label: "Overview", segment: "", icon: LayoutGrid, permission: "school.view" },
  { label: "Members", segment: "members", icon: Users, permission: "members.view" },
  { label: "Settings", segment: "settings", icon: Settings, permission: "school.settings.manage" },
];

export function navLinks(area: ShellArea): NavLink[] {
  if (area.kind === "platform") {
    return [{ label: "Schools", href: "/admin" as Route, icon: Building2 }];
  }
  return SCHOOL_NAV.filter((item) => can(area.roles, item.permission)).map((item) => ({
    label: item.label,
    href: schoolPath(area.school.slug, item.segment),
    icon: item.icon,
    exact: item.segment === "",
  }));
}

export function areaTitle(area: ShellArea): string {
  return area.kind === "platform" ? "EduBridge Platform" : area.school.name;
}
