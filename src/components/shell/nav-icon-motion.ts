import {
  Banknote,
  BedDouble,
  Blocks,
  BookOpen,
  Boxes,
  Building2,
  Bus,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  ChartLine,
  ClipboardList,
  DoorOpen,
  Gauge,
  GraduationCap,
  IdCard,
  Inbox,
  KeyRound,
  Landmark,
  Layers,
  LifeBuoy,
  Megaphone,
  MessageSquareText,
  Receipt,
  School,
  Settings,
  ShieldCheck,
  UserCheck,
  UserPlus,
  Users,
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/**
 * How each sidebar icon moves when its row is hovered or reached by keyboard (globals.css, "Sidebar icon motion").
 * One part of the icon makes a small gesture of what the link is for, played once: the wallet opens, the tassel
 * swings, the check is drawn. The icon itself never moves. Leave's plane has its own flight (sidebar-nav.tsx) and
 * is not listed here; an icon that is not listed stays still.
 */
export type IconMotion =
  | "needle"
  | "trace"
  | "type"
  | "tassel"
  | "plus"
  | "school"
  | "clock"
  | "check-first"
  | "check-last"
  | "list"
  | "buoy"
  | "wallet"
  | "columns"
  | "coin"
  | "card"
  | "horn"
  | "dots"
  | "door"
  | "bus"
  | "lift"
  | "redraw"
  | "book"
  | "bed"
  | "nudge"
  | "gear"
  | "windows"
  | "layers"
  | "block"
  | "receipt"
  | "inbox";

const MOTIONS = new Map<LucideIcon, IconMotion>([
  [Gauge, "needle"],
  [ChartLine, "trace"],
  [MessageSquareText, "type"],
  [GraduationCap, "tassel"],
  [UserPlus, "plus"],
  [School, "school"],
  [CalendarClock, "clock"],
  [CalendarCheck, "check-last"],
  [ClipboardList, "list"],
  [LifeBuoy, "buoy"],
  [Wallet, "wallet"],
  [Landmark, "columns"],
  [Banknote, "coin"],
  [IdCard, "card"],
  [Megaphone, "horn"],
  [CalendarDays, "dots"],
  [ShieldCheck, "check-last"],
  [DoorOpen, "door"],
  [UserCheck, "check-first"],
  [Bus, "bus"],
  [Boxes, "lift"],
  [Wrench, "redraw"],
  [BookOpen, "book"],
  [BedDouble, "bed"],
  [Users, "nudge"],
  [Settings, "gear"],
  [Building2, "windows"],
  [Layers, "layers"],
  [Blocks, "block"],
  [Receipt, "receipt"],
  [KeyRound, "redraw"],
  [Inbox, "inbox"],
]);

export function iconMotion(icon: LucideIcon): IconMotion | undefined {
  return MOTIONS.get(icon);
}
