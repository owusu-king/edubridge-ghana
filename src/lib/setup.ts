/**
 * The setup guide's steps and when each is done. Progress comes from the school's records, not from
 * ticking boxes, so the guide can never say something is set up when it is not.
 */

export const SETUP_STEPS = [
  "calendar",
  "classes",
  "teachers",
  "students",
  "guardians",
  "fees",
  "assessment",
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export type StepStatus = "done" | "started" | "todo";

/** What the guide counts. Students are active ones; "placed" means in a class this term. */
export interface SetupCounts {
  /** "Term 1, 2026/2027", or null when no term is current. */
  currentTerm: string | null;
  years: number;
  levels: number;
  classes: number;
  classesWithTeacher: number;
  /** Active staff other than proprietors, plus invitations not yet accepted. */
  staff: number;
  activeStudents: number;
  placedStudents: number;
  placedWithPhone: number;
  feeItems: number;
  /** Fee amounts set for the current term. */
  feeLines: number;
  /** Placed students with this term's fees charged. */
  billedStudents: number;
  /** Active levels with at least one active class. */
  levelsInUse: number;
  levelsInUseWithSubjects: number;
}

export interface StepState {
  status: StepStatus;
  /** One line on where it stands, in the school's terms. */
  detail: string;
}

const of = (n: number, total: number, what: string) => `${n} of ${total} ${what}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function setupState(c: SetupCounts): Record<SetupStep, StepState> {
  const placed = c.placedStudents;
  return {
    calendar: c.currentTerm
      ? { status: "done", detail: `Current term: ${c.currentTerm}.` }
      : c.years > 0
        ? { status: "started", detail: "An academic year is set up, but no term is marked as current." }
        : { status: "todo", detail: "No academic year yet." },
    classes:
      c.classes > 0
        ? {
            status: "done",
            detail: `${plural(c.classes, "class", "classes")} across ${plural(c.levels, "level")}.`,
          }
        : c.levels > 0
          ? { status: "started", detail: `${plural(c.levels, "level")} set up, but no classes yet.` }
          : { status: "todo", detail: "No levels or classes yet." },
    teachers:
      c.classes > 0 && c.classesWithTeacher === c.classes
        ? { status: "done", detail: "Every class has a class teacher." }
        : c.classes > 0 && (c.classesWithTeacher > 0 || c.staff > 0)
          ? {
              status: "started",
              detail: `${of(c.classesWithTeacher, c.classes, "classes")} have a class teacher.`,
            }
          : c.staff > 0
            ? { status: "started", detail: `${plural(c.staff, "staff member")} added. Classes come next.` }
            : { status: "todo", detail: "No staff added yet." },
    students:
      placed > 0 && placed === c.activeStudents
        ? { status: "done", detail: `${plural(placed, "student")} in classes this term.` }
        : c.activeStudents > 0
          ? {
              status: "started",
              detail: c.currentTerm
                ? `${plural(c.activeStudents - placed, "student")} not yet in a class this term.`
                : `${plural(c.activeStudents, "student")} added. Set the current term to place them in classes.`,
            }
          : { status: "todo", detail: "No students yet." },
    guardians:
      placed > 0 && c.placedWithPhone === placed
        ? { status: "done", detail: "Every student has a guardian's phone number." }
        : c.placedWithPhone > 0
          ? {
              status: "started",
              detail: `${of(c.placedWithPhone, placed, "students")} have a guardian's phone number.`,
            }
          : { status: "todo", detail: placed > 0 ? "No guardian phone numbers yet." : "Add students first." },
    fees:
      c.feeLines > 0 && placed > 0 && c.billedStudents >= placed
        ? { status: "done", detail: "Fees are set and every student has been billed this term." }
        : c.feeLines > 0
          ? {
              status: "started",
              detail:
                placed > 0
                  ? `Fees are set. ${of(c.billedStudents, placed, "students")} billed this term.`
                  : "Fees are set. Billing comes once students are in classes.",
            }
          : c.feeItems > 0
            ? { status: "started", detail: "Fee items added, but no fees set for this term." }
            : { status: "todo", detail: "No fee items yet." },
    assessment:
      c.levelsInUse > 0 && c.levelsInUseWithSubjects === c.levelsInUse
        ? { status: "done", detail: "Every level with classes has its subjects." }
        : c.levelsInUseWithSubjects > 0
          ? {
              status: "started",
              detail: `${of(c.levelsInUseWithSubjects, c.levelsInUse, "levels")} have subjects.`,
            }
          : { status: "todo", detail: c.levelsInUse > 0 ? "No subjects yet." : "Add classes first." },
  };
}
