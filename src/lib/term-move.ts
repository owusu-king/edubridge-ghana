/**
 * Planning a move of students from one term's classes into another's. Within a year, each class carries
 * over as it is. Into a new year, each class goes up to the matching class of the next level ("Basic 4A"
 * to "Basic 5A"), and the last level graduates. People choose or change every destination before anything
 * is saved; this module only works out the defaults and who goes where.
 */

export interface MoveClass {
  id: string;
  name: string;
  levelId: string;
  levelName: string;
  levelSequence: number;
  campusId: string;
  status: "active" | "archived";
}

export interface MoveLevel {
  id: string;
  name: string;
  sequence: number;
}

export type Destination = { kind: "class"; classId: string } | { kind: "graduate" } | { kind: "none" };

const squash = (text: string) => text.toLowerCase().replace(/\s+/g, "");

/** What is left of a class name after its level name: "Basic 4A" in "Basic 4" is "A". */
export function streamOf(cls: Pick<MoveClass, "name" | "levelName">): string {
  const name = squash(cls.name);
  const level = squash(cls.levelName);
  return name.startsWith(level) ? name.slice(level.length) : name;
}

/** The suggested destination for a class. */
export function defaultDestination(
  cls: MoveClass,
  classes: readonly MoveClass[],
  levels: readonly MoveLevel[],
  newYear: boolean,
): Destination {
  if (!newYear) return cls.status === "active" ? { kind: "class", classId: cls.id } : { kind: "none" };
  const next = [...levels]
    .sort((a, b) => a.sequence - b.sequence)
    .find((l) => l.sequence > cls.levelSequence);
  if (!next) return { kind: "graduate" };
  const candidates = classes.filter(
    (c) => c.status === "active" && c.levelId === next.id && c.campusId === cls.campusId,
  );
  const stream = streamOf(cls);
  const match =
    candidates.find((c) => streamOf(c) === stream) ??
    (candidates.length === 1 ? candidates[0] : undefined) ??
    [...candidates].sort((a, b) => a.name.localeCompare(b.name))[0];
  return match ? { kind: "class", classId: match.id } : { kind: "none" };
}

export interface MovingStudent {
  studentId: string;
  classId: string;
  /** Only active students move or graduate. */
  active: boolean;
}

export interface MovePlan {
  place: { studentId: string; classId: string }[];
  graduate: string[];
  /** Already in a class in the term moved into: left as they are. */
  alreadyPlaced: string[];
  /** Chosen not to move (repeating, leaving, or to place by hand). */
  leftOut: string[];
  /** In a class whose destination is "don't move", or no longer active. */
  notMoved: string[];
}

export function planMove(input: {
  students: readonly MovingStudent[];
  destinations: ReadonlyMap<string, Destination>;
  alreadyPlaced: ReadonlySet<string>;
  leftOut: ReadonlySet<string>;
}): MovePlan {
  const plan: MovePlan = { place: [], graduate: [], alreadyPlaced: [], leftOut: [], notMoved: [] };
  for (const s of input.students) {
    if (!s.active) plan.notMoved.push(s.studentId);
    else if (input.alreadyPlaced.has(s.studentId)) plan.alreadyPlaced.push(s.studentId);
    else if (input.leftOut.has(s.studentId)) plan.leftOut.push(s.studentId);
    else {
      const to = input.destinations.get(s.classId) ?? { kind: "none" };
      if (to.kind === "class") plan.place.push({ studentId: s.studentId, classId: to.classId });
      else if (to.kind === "graduate") plan.graduate.push(s.studentId);
      else plan.notMoved.push(s.studentId);
    }
  }
  return plan;
}

/** Form values: a class id, "graduate" or "none". */
export function parseDestination(value: string | undefined, classIds: ReadonlySet<string>): Destination {
  if (value === "graduate") return { kind: "graduate" };
  if (value && classIds.has(value)) return { kind: "class", classId: value };
  return { kind: "none" };
}

export function destinationValue(d: Destination): string {
  return d.kind === "class" ? d.classId : d.kind;
}
