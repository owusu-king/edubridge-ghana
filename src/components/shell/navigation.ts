import type { Route } from "next";
import {
  Banknote,
  Blocks,
  BedDouble,
  BookOpen,
  Boxes,
  Building2,
  Bus,
  CalendarCheck,
  CalendarDays,
  CalendarClock,
  ChartLine,
  ClipboardList,
  DoorOpen,
  Gauge,
  LifeBuoy,
  GraduationCap,
  IdCard,
  KeyRound,
  Layers,
  Megaphone,
  MessageSquareText,
  Plane,
  Receipt,
  School,
  ShieldCheck,
  Settings,
  UserCheck,
  UserPlus,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { allowed, type Access, type Permission, type Role } from "@/server/authz/permissions";
import type { Feature } from "@/lib/plan";
import { schoolPath } from "@/lib/routes";

export interface SchoolOption {
  slug: string;
  name: string;
  /** The school's logo, when it has one (TEN-04). */
  logoUrl?: string | null;
}

/** Which part of the product the shell is framing. Serializable, so it can cross to client components. */
export type ShellArea =
  | {
      kind: "school";
      school: SchoolOption;
      schools: SchoolOption[];
      roles: Role[];
      features: Feature[];
      modules?: Record<string, { state: "active" | "read_only" | "off" }>;
    }
  | { kind: "platform" };

export interface NavLink {
  label: string;
  href: Route;
  icon: LucideIcon;
  /** Match only the exact path, not sub-paths (for section roots). */
  exact?: boolean;
  /** Treat any path under this prefix as active (when the link opens a sub-page). */
  activePrefix?: Route;
  /** The labelled group the link sits in; links without one lead the list. */
  section?: NavSection;
}

export type NavSection =
  "Academics" | "Finance" | "People" | "Communication" | "Operations" | "Administration";

/** Settings tabs, each shown only to roles that may use it. The first visible tab is the Settings landing page. */
const SETTINGS_TABS: readonly { label: string; segment: string; permissions: Permission[] }[] = [
  { label: "Profile", segment: "settings", permissions: ["school.settings.manage"] },
  { label: "Calendar", segment: "settings/calendar", permissions: ["academics.manage"] },
  { label: "Attendance", segment: "settings/attendance", permissions: ["attendance.manage"] },
  { label: "Messages", segment: "settings/messages", permissions: ["fees.manage"] },
  { label: "Campuses", segment: "settings/campuses", permissions: ["campuses.manage"] },
  { label: "Plan", segment: "settings/plan", permissions: ["plan.view"] },
  { label: "Security", segment: "settings/security", permissions: ["security.manage"] },
  { label: "Assistant", segment: "settings/assistant", permissions: ["assistant.manage"] },
  { label: "Safeguarding", segment: "settings/safeguarding", permissions: ["safeguarding.appoint"] },
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

/**
 * Only modules that actually exist appear here. Nothing is shown as available before it works.
 * Listed in display order: the unlabelled essentials first, then each section in turn.
 */
const SCHOOL_NAV: readonly {
  label: string;
  segment: string;
  icon: LucideIcon;
  permission: Permission;
  /** Left out when the member has this permission too (a fuller link covers it). */
  hideWith?: Permission;
  section?: NavSection;
}[] = [
  { label: "Command Center", segment: "", icon: Gauge, permission: "school.view" },
  { label: "Insights", segment: "insights", icon: ChartLine, permission: "insights.view" },
  { label: "Assistant", segment: "assistant", icon: MessageSquareText, permission: "assistant.use" },

  {
    label: "Students",
    segment: "students",
    icon: GraduationCap,
    permission: "students.view",
    section: "Academics",
  },
  {
    label: "Admissions",
    segment: "admissions",
    icon: UserPlus,
    permission: "admissions.view",
    section: "Academics",
  },
  { label: "Classes", segment: "classes", icon: School, permission: "classes.view", section: "Academics" },
  {
    label: "Timetable",
    segment: "timetable",
    icon: CalendarClock,
    permission: "timetable.view",
    section: "Academics",
  },
  {
    label: "Attendance",
    segment: "attendance",
    icon: CalendarCheck,
    permission: "attendance.take",
    section: "Academics",
  },
  {
    label: "Assessment",
    segment: "assessment",
    icon: ClipboardList,
    permission: "assessment.enter",
    section: "Academics",
  },
  {
    label: "Early warning",
    segment: "early-warning",
    icon: LifeBuoy,
    permission: "early_warning.view",
    section: "Academics",
  },

  { label: "Fees", segment: "fees", icon: Wallet, permission: "fees.view", section: "Finance" },
  { label: "Payroll", segment: "payroll", icon: Banknote, permission: "payroll.view", section: "Finance" },
  {
    label: "Payslips",
    segment: "payroll",
    icon: Banknote,
    permission: "payroll.own",
    hideWith: "payroll.view",
    section: "Finance",
  },

  { label: "Staff", segment: "staff", icon: IdCard, permission: "staff.view", section: "People" },
  { label: "Leave", segment: "leave", icon: Plane, permission: "leave.request", section: "People" },

  {
    label: "Announcements",
    segment: "announcements",
    icon: Megaphone,
    permission: "communication.send",
    section: "Communication",
  },
  {
    label: "Events",
    segment: "events",
    icon: CalendarDays,
    permission: "events.view",
    section: "Communication",
  },

  {
    label: "Safeguarding",
    segment: "safeguarding",
    icon: ShieldCheck,
    permission: "safeguarding.report",
    section: "Operations",
  },
  {
    label: "Visitors",
    segment: "visitors",
    icon: DoorOpen,
    permission: "visitors.view",
    section: "Operations",
  },
  { label: "Pickup", segment: "pickup", icon: UserCheck, permission: "pickup.view", section: "Operations" },
  {
    label: "Transport",
    segment: "transport",
    icon: Bus,
    permission: "transport.view",
    section: "Operations",
  },
  {
    label: "Transport",
    segment: "transport/trips",
    icon: Bus,
    permission: "transport.trips",
    hideWith: "transport.view",
    section: "Operations",
  },
  {
    label: "Inventory",
    segment: "inventory",
    icon: Boxes,
    permission: "inventory.view",
    section: "Operations",
  },
  {
    label: "Maintenance",
    segment: "inventory/maintenance",
    icon: Wrench,
    permission: "maintenance.report",
    hideWith: "inventory.view",
    section: "Operations",
  },
  { label: "Library", segment: "library", icon: BookOpen, permission: "library.view", section: "Operations" },
  {
    label: "Boarding",
    segment: "boarding",
    icon: BedDouble,
    permission: "boarding.view",
    section: "Operations",
  },

  {
    label: "Members",
    segment: "members",
    icon: Users,
    permission: "members.view",
    section: "Administration",
  },
];

export function navLinks(area: ShellArea): NavLink[] {
  if (area.kind === "platform") {
    return [
      { label: "Schools", href: "/admin" as Route, icon: Building2 },
      { label: "Plans", href: "/admin/plans" as Route, icon: Layers },
      { label: "Modules", href: "/admin/modules" as Route, icon: Blocks },
      { label: "Billing", href: "/admin/billing" as Route, icon: Receipt },
      { label: "Integrations", href: "/admin/integrations" as Route, icon: KeyRound },
    ];
  }
  const links: NavLink[] = SCHOOL_NAV.filter(
    (item) => allowed(area, item.permission) && !(item.hideWith && allowed(area, item.hideWith)),
  ).map((item) => ({
    label: item.label,
    href: schoolPath(area.school.slug, item.segment),
    icon: item.icon,
    exact: item.segment === "",
    section: item.section,
  }));
  const [firstTab] = settingsTabs(area.school.slug, area);
  // Highlight Settings for every settings tab, whichever one it opens on.
  if (firstTab)
    links.push({
      label: "Settings",
      href: firstTab.href,
      icon: Settings,
      activePrefix: schoolPath(area.school.slug, "settings"),
      section: "Administration",
    });
  return links;
}

export function areaTitle(area: ShellArea): string {
  return area.kind === "platform" ? "EduBridge Platform" : area.school.name;
}
