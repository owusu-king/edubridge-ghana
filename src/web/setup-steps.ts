import type { Route } from "next";
import { can, ROLE_LABELS, ROLES, type Permission, type Role } from "@/server/authz/permissions";
import type { SetupPath, SetupStep } from "@/lib/setup";
import { schoolPath } from "@/lib/routes";

interface StepInfo {
  title: string;
  why: string;
  action: string;
  segment: string;
  permission: Permission;
}

/** What each setup step is, why it matters, and where it is done. */
export const STEP_INFO: Record<SetupStep, StepInfo> = {
  calendar: {
    title: "Set up the academic calendar",
    why: "Terms decide billing, registers and report cards. Add this year and its terms, and mark the current one.",
    action: "Open the calendar",
    segment: "settings/calendar",
    permission: "academics.manage",
  },
  classes: {
    title: "Add levels and classes",
    why: "Ghana's levels, from Creche to JHS 3, can be added in one step; then add a class for each stream.",
    action: "Open classes",
    segment: "classes",
    permission: "academics.manage",
  },
  teachers: {
    title: "Invite staff and assign class teachers",
    why: "Class teachers take their class's register and enter its marks. Invite them, then choose each class's teacher under Classes.",
    action: "Open members",
    segment: "members",
    permission: "members.manage",
  },
  students: {
    title: "Add students",
    why: "Import your register from a spreadsheet (with classes and guardians), or add students one at a time.",
    action: "Import students",
    segment: "students/import",
    permission: "students.manage",
  },
  guardians: {
    title: "Add guardians' phone numbers",
    why: "Fee reminders and the parent view reach families through these numbers.",
    action: "Open students",
    segment: "students",
    permission: "students.manage",
  },
  fees: {
    title: "Set fees and bill the term",
    why: "Set each level's fees for the term, then bill every student in one step. Add any balances owed from before.",
    action: "Open fees",
    segment: "fees",
    permission: "fees.manage",
  },
  balances: {
    title: "Bring in balances owed from before",
    why: "What each family still owed in your old system, or had paid ahead, so the first bill starts from the right amount. Matched to students by admission number.",
    action: "Import balances",
    segment: "fees/opening-balances",
    permission: "fees.manage",
  },
  assessment: {
    title: "Choose subjects for report cards",
    why: "Ghana's curriculum subjects for each level can be added in one step, with the usual grading.",
    action: "Open assessment setup",
    segment: "assessment/setup",
    permission: "academics.manage",
  },
};

const STAFF: readonly Role[] = ROLES.filter((r) => r !== "parent" && r !== "student");

/** "Proprietor or Accountant": the roles that can do a step. */
export function whoCan(permission: Permission): string {
  const labels = STAFF.filter((r) => can([r], permission)).map((r) => ROLE_LABELS[r]);
  return labels.length <= 1 ? (labels[0] ?? "") : `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}`;
}

/** How the steps read for a school moving from another system, where they differ (2026-11-19). */
const SWITCH_INFO: Partial<Record<SetupStep, Partial<StepInfo>>> = {
  classes: {
    why: "Add each level, then a class for each stream, named as in your old system (for example Basic 4A), so the student list finds every class when you import it.",
  },
  students: {
    title: "Import your student list",
    why: "Upload the list from your old system as a spreadsheet. Columns such as “Adm No”, “Surname” or “Form” are matched for you, every row is checked before anything is saved, and you can correct the file and upload it again.",
  },
  guardians: {
    why: "Students imported without a guardian's phone number are listed here. Fee reminders and the parent view reach families through these numbers.",
  },
  fees: {
    why: "Set each level's fees for this term, then bill every student in one step. Balances brought in from your old records are added to the first bill.",
  },
  teachers: {
    title: "Bring in your staff",
    why: "Import your staff list from a spreadsheet, teaching and support staff alike. Then invite the people who will sign in from Members, and choose each class's teacher under Classes.",
  },
};

export function stepInfo(step: SetupStep, path: SetupPath = "fresh"): StepInfo {
  return path === "switch" ? { ...STEP_INFO[step], ...SWITCH_INFO[step] } : STEP_INFO[step];
}

export const stepHref = (slug: string, step: SetupStep): Route => schoolPath(slug, STEP_INFO[step].segment);
