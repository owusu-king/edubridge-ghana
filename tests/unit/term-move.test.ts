import { describe, expect, it } from "vitest";
import {
  defaultDestination,
  parseDestination,
  planMove,
  streamOf,
  type MoveClass,
  type MoveLevel,
} from "@/lib/term-move";

const levels: MoveLevel[] = [
  { id: "b4", name: "Basic 4", sequence: 90 },
  { id: "b5", name: "Basic 5", sequence: 100 },
  { id: "b6", name: "Basic 6", sequence: 110 },
  { id: "j1", name: "JHS 1", sequence: 120 },
];
const cls = (
  id: string,
  name: string,
  levelId: string,
  campusId = "main",
  status: MoveClass["status"] = "active",
): MoveClass => {
  const level = levels.find((l) => l.id === levelId)!;
  return { id, name, levelId, levelName: level.name, levelSequence: level.sequence, campusId, status };
};
const classes = [
  cls("4a", "Basic 4A", "b4"),
  cls("4b", "Basic 4B", "b4"),
  cls("4s", "Basic 4", "b4", "sakumono"),
  cls("5a", "Basic 5A", "b5"),
  cls("5b", "Basic 5 B", "b5"),
  cls("5s", "Basic 5 Sakumono", "b5", "sakumono"),
  cls("6a", "Basic 6A", "b6"),
  cls("6old", "Basic 6 Old", "b6", "main", "archived"),
];

describe("where a class goes", () => {
  it("reads the stream from a class name", () => {
    expect(streamOf({ name: "Basic 4A", levelName: "Basic 4" })).toBe("a");
    expect(streamOf({ name: "Basic 5 B", levelName: "Basic 5" })).toBe("b");
    expect(streamOf({ name: "Gold", levelName: "Basic 5" })).toBe("gold");
  });

  it("carries a class over within a year", () => {
    expect(defaultDestination(classes[0]!, classes, levels, false)).toEqual({ kind: "class", classId: "4a" });
    expect(defaultDestination(classes[7]!, classes, levels, false)).toEqual({ kind: "none" });
  });

  it("goes up to the matching class of the next level, at the same campus, in a new year", () => {
    expect(defaultDestination(classes[0]!, classes, levels, true)).toEqual({ kind: "class", classId: "5a" });
    expect(defaultDestination(classes[1]!, classes, levels, true)).toEqual({ kind: "class", classId: "5b" });
    // The only Basic 5 class at Sakumono, though its name differs.
    expect(defaultDestination(classes[2]!, classes, levels, true)).toEqual({ kind: "class", classId: "5s" });
  });

  it("asks when the next level has no class, and graduates the last level", () => {
    // JHS 1 exists as a level but has no class yet: someone must choose.
    expect(defaultDestination(classes[6]!, classes, levels, true)).toEqual({ kind: "none" });
    expect(defaultDestination(cls("j", "JHS 1A", "j1"), classes, levels, true)).toEqual({ kind: "graduate" });
  });

  it("reads form values safely", () => {
    const ids = new Set(["5a"]);
    expect(parseDestination("5a", ids)).toEqual({ kind: "class", classId: "5a" });
    expect(parseDestination("graduate", ids)).toEqual({ kind: "graduate" });
    expect(parseDestination("someone-else's-class", ids)).toEqual({ kind: "none" });
    expect(parseDestination(undefined, ids)).toEqual({ kind: "none" });
  });
});

describe("who moves", () => {
  it("places, graduates and leaves out students as chosen, and never moves anyone twice", () => {
    const plan = planMove({
      students: [
        { studentId: "ama", classId: "4a", active: true },
        { studentId: "kofi", classId: "4a", active: true },
        { studentId: "esi", classId: "4a", active: true },
        { studentId: "yaw", classId: "6a", active: true },
        { studentId: "abena", classId: "4b", active: true },
        { studentId: "left", classId: "4a", active: false },
      ],
      destinations: new Map([
        ["4a", { kind: "class", classId: "5a" }],
        ["6a", { kind: "graduate" }],
        ["4b", { kind: "none" }],
      ]),
      alreadyPlaced: new Set(["esi"]),
      leftOut: new Set(["kofi"]),
    });
    expect(plan).toEqual({
      place: [{ studentId: "ama", classId: "5a" }],
      graduate: ["yaw"],
      alreadyPlaced: ["esi"],
      leftOut: ["kofi"],
      notMoved: ["abena", "left"],
    });
  });
});
