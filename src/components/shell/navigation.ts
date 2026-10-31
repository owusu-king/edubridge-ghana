import type { Route } from "next";
import { LayoutGrid, Settings, Users, type LucideIcon } from "lucide-react";
import { can, type Permission, type Role } from "@/server/authz/permissions";
import { schoolPath } from "@/lib/routes";

export interface NavItem {
  label: string;
  /** Path below the school, "" for the school's overview. */
  segment: string;
  icon: LucideIcon;
  permission: Permission;
}

/** Only modules that actually exist appear here. Nothing is shown as available before it works. */
export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Overview", segment: "", icon: LayoutGrid, permission: "school.view" },
  { label: "Members", segment: "members", icon: Users, permission: "members.view" },
  { label: "Settings", segment: "settings", icon: Settings, permission: "school.settings.manage" },
];

export function visibleNavItems(roles: readonly Role[]): NavItem[] {
  return NAV_ITEMS.filter((item) => can(roles, item.permission));
}

export function navHref(slug: string, segment: string): Route {
  return schoolPath(slug, segment);
}
