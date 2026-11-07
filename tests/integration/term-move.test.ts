import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createAcademicYear, listAcademicYears, setCurrentTerm } from "@/server/academics/calendar";
import { createClass, listLevelsWithClasses } from "@/server/academics/classes";
import { getMovePreview, moveStudents, pendingMove, undoMove } from "@/server/academics/term-move";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { academicYears, campuses, enrolments, students, terms } from "@/server/db/schema";
import { billTerm } from "@/server/fees/ledger";
import { listFeeItems, saveLevelFees } from "@/server/fees/structure";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const asSchool = <T>(s: School, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, fn);

const classOf = (s: School, studentId: string, termId: string) =>
  asSchool(s, async (tx) => {
    const [row] = await tx
      .select({ classId: enrolments.classId })
      .from(enrolments)
      .where(and(eq(enrolments.studentId, studentId), eq(enrolments.termId, termId)));
    return row?.classId ?? null;
  });

const statusOf = (s: School, studentId: string) =>
  asSchool(s, async (tx) => (await tx.select().from(students).where(eq(students.id, studentId)))[0]!.status);

/** Adds Term 2 to the school's current year (2026/2027). */
async function withTermTwo(s: School) {
  return asSchool(s, async (tx) => {
    const [year] = await tx.select().from(academicYears).where(eq(academicYears.tenantId, s.tenant.id));
    await tx.update(academicYears).set({ endsOn: "2027-04-09" }).where(eq(academicYears.id, year!.id));
    const [term] = await tx
      .insert(terms)
      .values({
        tenantId: s.tenant.id,
        academicYearId: year!.id,
        name: "Term 2",
        sequence: 2,
        startsOn: "2027-01-11",
        endsOn: "2027-04-09",
      })
      .returning({ id: terms.id });
    return term!.id;
  });
}

describe("moving students within a year", () => {
  it("carries every class over, keeps chosen students back, and never places anyone twice", async () => {
    const s = await school();
    const ama = (await s.add("Ama", s.classA)).id;
    const kofi = (await s.add("Kofi", s.classA)).id;
    const esi = (await s.add("Esi", s.classB)).id;
    const termTwo = await withTermTwo(s);

    // The school changes term before moving anyone: the overview asks for the move.
    await setCurrentTerm(conn.app, s.owner, termTwo);
    expect(await pendingMove(conn.app, s.owner)).toMatchObject({
      from: { id: s.termId },
      to: { id: termTwo },
    });

    const preview = await getMovePreview(conn.app, s.owner);
    expect(preview.from).toBeTruthy();
    // With Term 2 current, the default "from" is Term 2 itself, which has nobody: choose Term 1.
    const fromOne = await getMovePreview(conn.app, s.owner, { from: s.termId, to: termTwo });
    expect(fromOne.newYear).toBe(false);
    expect(fromOne.classes.map((c) => [c.cls.name, c.destination, c.students.length])).toEqual([
      ["Basic 4A", { kind: "class", classId: s.classA }, 2],
      ["Basic 4B", { kind: "class", classId: s.classB }, 1],
    ]);

    const first = await moveStudents(conn.app, s.owner, {
      fromTermId: s.termId,
      toTermId: termTwo,
      destinations: { [s.classA]: s.classA, [s.classB]: s.classB },
      leaveOut: [kofi],
    });
    expect(first).toMatchObject({ placed: 2, graduated: 0, leftOut: [kofi] });
    expect(await classOf(s, ama, termTwo)).toBe(s.classA);
    expect(await classOf(s, esi, termTwo)).toBe(s.classB);
    expect(await classOf(s, kofi, termTwo)).toBeNull();
    expect(await pendingMove(conn.app, s.owner)).toBeNull();

    // Running it again only places who is still missing.
    const again = await moveStudents(conn.app, s.owner, {
      fromTermId: s.termId,
      toTermId: termTwo,
      destinations: { [s.classA]: s.classA, [s.classB]: s.classB },
    });
    expect(again.placed).toBe(1);
    expect(again.alreadyPlaced.sort()).toEqual([ama, esi].sort());
    await expect(
      moveStudents(conn.app, s.owner, {
        fromTermId: s.termId,
        toTermId: termTwo,
        destinations: { [s.classA]: s.classA },
      }),
    ).rejects.toMatchObject({ code: "nothing_to_move" });
    await expect(
      moveStudents(conn.app, s.owner, {
        fromTermId: s.termId,
        toTermId: termTwo,
        destinations: { [s.classA]: "graduate" },
      }),
    ).rejects.toMatchObject({ code: "graduate_within_year" });
    await expect(
      moveStudents(conn.app, s.owner, { fromTermId: termTwo, toTermId: s.termId, destinations: {} }),
    ).rejects.toMatchObject({ code: "move_backwards" });
    await expect(getMovePreview(conn.app, s.teacher)).rejects.toThrow(ForbiddenError);
    await expect(getMovePreview(conn.app, s.bursar)).rejects.toThrow(ForbiddenError);
  });
});

describe("moving students into a new year", () => {
  async function newYear(s: School) {
    await createAcademicYear(conn.app, s.owner, {
      name: "2027/2028",
      terms: [{ name: "Term 1", startsOn: "2027-09-13", endsOn: "2027-12-17" }],
    });
    const years = await listAcademicYears(conn.app, s.owner);
    const nextTerm = years.find((y) => y.name === "2027/2028")!.terms[0]!.id;
    const levels = await listLevelsWithClasses(conn.app, s.owner);
    const level = (name: string) => levels.find((l) => l.name === name)!.id;
    const rows = await asSchool(s, (tx) =>
      tx.select().from(campuses).where(eq(campuses.tenantId, s.tenant.id)),
    );
    const main = rows.find((r) => r.name === "Main")!;
    const east = rows.find((r) => r.name === "East")!;
    const fiveA = await createClass(conn.app, s.owner, {
      levelId: level("Basic 5"),
      campusId: main.id,
      name: "Basic 5A",
    });
    const fiveB = await createClass(conn.app, s.owner, {
      levelId: level("Basic 5"),
      campusId: east.id,
      name: "Basic 5B",
    });
    const sixA = await createClass(conn.app, s.owner, {
      levelId: level("Basic 6"),
      campusId: main.id,
      name: "Basic 6A",
    });
    return { nextTerm, fiveA, fiveB, sixA };
  }

  it("moves each class up a level, graduates the last, and can be undone", async () => {
    const s = await school();
    const ama = (await s.add("Ama", s.classA)).id;
    const esi = (await s.add("Esi", s.classB)).id;
    const { nextTerm, fiveA, fiveB, sixA } = await newYear(s);
    const yaw = (await s.add("Yaw", sixA)).id;

    const preview = await getMovePreview(conn.app, s.owner, { from: s.termId, to: nextTerm });
    expect(preview.newYear).toBe(true);
    const destination = Object.fromEntries(preview.classes.map((c) => [c.cls.name, c.destination]));
    expect(destination).toEqual({
      "Basic 4A": { kind: "class", classId: fiveA },
      "Basic 4B": { kind: "class", classId: fiveB },
      "Basic 6A": { kind: "graduate" },
    });

    const result = await moveStudents(conn.app, s.owner, {
      fromTermId: s.termId,
      toTermId: nextTerm,
      destinations: { [s.classA]: fiveA, [s.classB]: fiveB, [sixA]: "graduate" },
    });
    expect(result).toMatchObject({ placed: 2, graduated: 1 });
    expect(await classOf(s, ama, nextTerm)).toBe(fiveA);
    expect(await classOf(s, esi, nextTerm)).toBe(fiveB);
    expect(await statusOf(s, yaw)).toBe("graduated");
    // Last term's classes are history and stay as they were.
    expect(await classOf(s, ama, s.termId)).toBe(s.classA);

    await undoMove(conn.app, s.owner, result.moveId);
    expect(await classOf(s, ama, nextTerm)).toBeNull();
    expect(await statusOf(s, yaw)).toBe("active");
    await expect(undoMove(conn.app, s.owner, result.moveId)).rejects.toMatchObject({
      code: "already_undone",
    });
    const moves = (await getMovePreview(conn.app, s.owner, { from: s.termId, to: nextTerm })).moves;
    expect(moves[0]).toMatchObject({ placed: 2, graduated: 1 });
    expect(moves[0]!.undoneAt).toBeInstanceOf(Date);
  });

  it("cannot be undone once fees are billed for the new term", async () => {
    const s = await school();
    await s.add("Ama", s.classA);
    const { nextTerm, fiveA, fiveB, sixA } = await newYear(s);
    const result = await moveStudents(conn.app, s.owner, {
      fromTermId: s.termId,
      toTermId: nextTerm,
      destinations: { [s.classA]: fiveA, [s.classB]: fiveB, [sixA]: "graduate" },
    });
    const levels = await listLevelsWithClasses(conn.app, s.owner);
    const [tuition] = await listFeeItems(conn.app, s.bursar);
    await saveLevelFees(conn.app, s.bursar, nextTerm, levels.find((l) => l.name === "Basic 5")!.id, {
      amounts: { [tuition!.id]: "1200" },
      classAmounts: {},
    });
    await billTerm(conn.app, s.bursar, nextTerm);
    await expect(undoMove(conn.app, s.owner, result.moveId)).rejects.toMatchObject({
      code: "move_in_use",
      message:
        "This move can no longer be undone: in the new term, 1 of these students have fees billed. Change classes one student at a time instead.",
    });
  });
});
