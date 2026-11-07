import type { Route } from "next";
import {
  Building2,
  CalendarCheck,
  ChartLine,
  ClipboardList,
  GraduationCap,
  LayoutGrid,
  Megaphone,
  MessageSquareText,
  Receipt,
  School,
  Settings,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { allowed, type Access, type Permission, type Role } from "@/server/authz/permissions";
import type { Feature } from "@/lib/plan";
import { schoolPath } from "@/lib/routes";

export interface SchoolOption {
  slug: string;
  name: string;
}

/** Which part of the product the shell is framing. Serializable, so it can cross to client components. */
export type ShellArea =
  | { kind: "school"; school: SchoolOption; schools: SchoolOption[]; roles: Role[]; features: Feature[] }
  | { kind: "platform" };

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
const SETTINGS_TABS: readonly { label: string; segment: string; permissions: Permission[] }[] = [
  { label: "Profile", segment: "settings", permissions: ["school.settings.manage"] },
  { label: "Calendar", segment: "settings/calendar", permissions: ["academics.manage"] },
  { label: "Attendance", segment: "settings/attendance", permissions: ["attendance.manage"] },
  { label: "Messages", segment: "settings/messages", permissions: ["fees.manage"] },
  { label: "Campuses", segment: "settings/campuses", permissions: ["campuses.manage"] },
  { label: "Plan", segment: "settings/plan", permissions: ["plan.view"] },
  { label: "Security", segment: "settings/security", permissions: ["security.manage"] },
  { label: "Support access", segment: "settings/support", permissions: ["support.manage"] },
  { label: "Data export", segment: "settings/export", permissions: ["data.export", "fees.export"] },
  { label: "Audit log", segment: "settings/audit", permissions: ["audit.view"] },
];

export function settingsTabs(slug: string, access: Access): { label: string; href: Route }[] {
  return SETTINGS_TABS.filter((t) => t.permissions.some((p) => allowed(access, p))).map((t) => ({
    label: t.label,
    href: schoolPath(slug, t.segment),
  }));
}

/** Only modules that actually exist appear here. Nothing is shown as available before it works. */
const SCHOOL_NAV: readonly { label: string; segment: string; icon: LucideIcon; permission: Permission }[] = [
  { label: "Overview", segment: "", icon: LayoutGrid, permission: "school.view" },
  { label: "Students", segment: "students", icon: GraduationCap, permission: "students.view" },
  { label: "Classes", segment: "classes", icon: School, permission: "classes.view" },
  { label: "Attendance", segment: "attendance", icon: CalendarCheck, permission: "attendance.take" },
  { label: "Assessment", segment: "assessment", icon: ClipboardList, permission: "assessment.enter" },
  { label: "Fees", segment: "fees", icon: Wallet, permission: "fees.view" },
  { label: "Insights", segment: "insights", icon: ChartLine, permission: "insights.view" },
  { label: "Assistant", segment: "assistant", icon: MessageSquareText, permission: "assistant.use" },
  { label: "Announcements", segment: "announcements", icon: Megaphone, permission: "communication.send" },
  { label: "Members", segment: "members", icon: Users, permission: "members.view" },
];

export function navLinks(area: ShellArea): NavLink[] {
  if (area.kind === "platform") {
    return [
      { label: "Schools", href: "/admin" as Route, icon: Building2 },
      { label: "Billing", href: "/admin/billing" as Route, icon: Receipt },
    ];
  }
  const links: NavLink[] = SCHOOL_NAV.filter((item) => allowed(area, item.permission)).map((item) => ({
    label: item.label,
    href: schoolPath(area.school.slug, item.segment),
    icon: item.icon,
    exact: item.segment === "",
  }));
  const [firstTab] = settingsTabs(area.school.slug, area);
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
