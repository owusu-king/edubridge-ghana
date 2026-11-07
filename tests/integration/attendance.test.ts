import { randomInt } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { listTeacherOptions, updateClass } from "@/server/academics/classes";
import { getReportCard, saveReportRemarks } from "@/server/assessment/report-cards";
import { setupDefaultSubjects } from "@/server/assessment/setup";
import { getClassAttendance, getRegister, listRegisters, syncRegister } from "@/server/attendance/registers";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { academicYears, attendanceChanges, attendanceMarks, auditEvents, terms } from "@/server/db/schema";
import { DomainError } from "@/server/errors";
import { getParentChild } from "@/server/parents/portal";
import { addGuardian } from "@/server/students/guardians";
import { addDays } from "@/lib/attendance";
import { todayIn } from "@/lib/format";
import { normalizePhone } from "@/lib/phone";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const asSchool = <T>(s: School, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, fn);

/**
 * A school whose current term runs around today (so "today" is always a school day), a class teacher for
 * Basic 4A and three pupils in it.
 */
async function setUp() {
  const s = await school();
  const today = todayIn(s.tenant.timezone);
  await asSchool(s, async (tx) => {
    await tx
      .update(terms)
      .set({ startsOn: addDays(today, -60), endsOn: addDays(today, 60) })
      .where(eq(terms.id, s.termId));
    await tx
      .update(academicYears)
      .set({ startsOn: addDays(today, -60), endsOn: addDays(today, 60) })
      .where(eq(academicYears.tenantId, s.tenant.id));
  });
  const teacher = (await listTeacherOptions(conn.app, s.owner)).find((t) => t.name === "Teacher")!;
  await updateClass(conn.app, s.owner, s.classA, {
    name: "Basic 4A",
    classTeacherMembershipId: teacher.membershipId,
  });
  const ama = await s.add("Ama", s.classA);
  const kofi = await s.add("Kofi", s.classA);
  const yaw = await s.add("Yaw", s.classA);
  return { s, today, ama, kofi, yaw };
}

const take = (
  s: School,
  ctx: School["owner"],
  date: string,
  marks: {
    studentId: string;
    status: "present" | "late" | "absent" | "excused";
    reason?: string;
    baseVersion: number;
  }[],
  source: "online" | "offline" | "kept_mine" = "online",
  classId = s.classA,
) =>
  syncRegister(conn.app, ctx, {
    classId,
    date,
    source,
    marks,
    ...(source === "offline" ? { recordedAt: new Date().toISOString() } : {}),
  });

describe("taking the register", () => {
  it("lets the class teacher take their own class's register, and records who and when", async () => {
    const { s, today, ama, kofi, yaw } = await setUp();
    const listed = await listRegisters(conn.app, s.teacher, today);
    expect(listed.classes.map((c) => [c.cls.name, c.students, c.register])).toEqual([["Basic 4A", 3, null]]);
    await expect(getRegister(conn.app, s.teacher, s.classB, today)).resolves.toBeNull();
    await expect(listRegisters(conn.app, s.bursar, today)).rejects.toThrow(ForbiddenError);

    const result = await take(s, s.teacher, today, [
      { studentId: ama.id, status: "present", baseVersion: 0 },
      { studentId: kofi.id, status: "absent", reason: " Sick ", baseVersion: 0 },
      { studentId: yaw.id, status: "late", reason: "Ignored for late", baseVersion: 0 },
    ]);
    expect(result).toEqual({ applied: 3, unchanged: 0, conflicts: [], skipped: [], alerts: 0 });
    const register = (await getRegister(conn.app, s.teacher, s.classA, today))!;
    expect(register.takenBy).toBe("Teacher");
    expect(
      register.students.map((x) => [x.firstName, x.mark?.status, x.mark?.reason, x.mark?.version]),
    ).toEqual([
      ["Ama", "present", null, 1],
      ["Kofi", "absent", "Sick", 1],
      ["Yaw", "late", null, 1],
    ]);
    const after = await listRegisters(conn.app, s.teacher, today);
    expect(after.classes[0]!.register).toMatchObject({
      takenBy: "Teacher",
      marked: 3,
      counts: { present: 1, absent: 1, late: 1, excused: 0 },
    });
    await expect(
      take(
        s,
        s.teacher,
        today,
        [{ studentId: ama.id, status: "present", baseVersion: 0 }],
        "online",
        s.classB,
      ),
    ).rejects.toThrow("Class not found.");
    const [audit] = await asSchool(s, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(
          and(eq(auditEvents.tenantId, s.tenant.id), eq(auditEvents.action, "attendance.register_saved")),
        ),
    );
    expect(audit!.metadata).toMatchObject({ class: "Basic 4A", date: today, marks: 3 });
  });

  it("refuses future days and days outside a term, and old registers for teachers but not the head teacher", async () => {
    const { s, today, ama } = await setUp();
    const mark = [{ studentId: ama.id, status: "present" as const, baseVersion: 0 }];
    await expect(take(s, s.teacher, addDays(today, 1), mark)).rejects.toThrow(/today or earlier/);
    await expect(take(s, s.owner, addDays(today, -90), mark)).rejects.toThrow(/not in a term/);
    await expect(take(s, s.teacher, addDays(today, -8), mark)).rejects.toThrow(/up to 7 days back/);
    expect((await take(s, s.teacher, addDays(today, -7), mark)).applied).toBe(1);
    expect((await take(s, s.head, addDays(today, -30), mark)).applied).toBe(1);
    await expect(take(s, s.teacher, "2026-02-30", mark)).rejects.toThrow(DomainError);
  });
});

describe("changes made offline", () => {
  it("never overwrites a mark someone else changed: it comes back as a conflict to decide", async () => {
    const { s, today, ama, kofi, yaw } = await setUp();
    await take(s, s.teacher, today, [
      { studentId: ama.id, status: "present", baseVersion: 0 },
      { studentId: kofi.id, status: "present", baseVersion: 0 },
      { studentId: yaw.id, status: "present", baseVersion: 0 },
    ]);
    // The teacher's phone goes offline; the head teacher marks Ama late at the office meanwhile.
    expect(
      (await take(s, s.head, today, [{ studentId: ama.id, status: "late", baseVersion: 1 }])).applied,
    ).toBe(1);
    // Back online, the phone sends what it recorded offline, made from version 1.
    const offline = [
      { studentId: ama.id, status: "absent" as const, reason: "Sick", baseVersion: 1 },
      { studentId: kofi.id, status: "absent" as const, baseVersion: 1 },
    ];
    const first = await take(s, s.teacher, today, offline, "offline");
    expect(first.applied).toBe(1);
    expect(first.conflicts).toMatchObject([
      {
        studentId: ama.id,
        name: "Ama Mensah",
        yours: { status: "absent", reason: "Sick" },
        theirs: { status: "late", version: 2, by: "Head" },
      },
    ]);
    // Sending the same thing again (e.g. the answer was lost) applies nothing twice.
    const retry = await take(s, s.teacher, today, offline, "offline");
    expect(retry).toMatchObject({ applied: 0, unchanged: 1 });
    expect(retry.conflicts).toHaveLength(1);

    // The teacher decides to keep their own mark: made from the version they were shown.
    expect(
      (
        await take(
          s,
          s.teacher,
          today,
          [{ studentId: ama.id, status: "absent", reason: "Sick", baseVersion: 2 }],
          "kept_mine",
        )
      ).applied,
    ).toBe(1);
    const register = (await getRegister(conn.app, s.teacher, s.classA, today))!;
    expect(register.students.find((x) => x.id === ama.id)!.mark).toMatchObject({
      status: "absent",
      reason: "Sick",
      version: 3,
    });

    const history = await asSchool(s, (tx) =>
      tx
        .select({
          from: attendanceChanges.fromStatus,
          to: attendanceChanges.toStatus,
          source: attendanceChanges.source,
          version: attendanceChanges.version,
        })
        .from(attendanceChanges)
        .where(eq(attendanceChanges.studentId, ama.id))
        .orderBy(asc(attendanceChanges.version)),
    );
    expect(history).toEqual([
      { from: null, to: "present", source: "online", version: 1 },
      { from: "present", to: "late", source: "online", version: 2 },
      { from: "late", to: "absent", source: "kept_mine", version: 3 },
    ]);
    // The history cannot be rewritten, and versions only step by one.
    await expect(
      withTenant(conn.app, { tenantId: s.tenant.id, userId: "" }, (tx) =>
        tx
          .update(attendanceChanges)
          .set({ toStatus: "present" })
          .where(eq(attendanceChanges.studentId, ama.id)),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(conn.app, { tenantId: s.tenant.id, userId: "" }, (tx) =>
        tx.update(attendanceMarks).set({ version: 9 }).where(eq(attendanceMarks.studentId, ama.id)),
      ),
    ).rejects.toThrow();
  });

  it("applies exactly one of two changes made from the same version at the same moment", async () => {
    const { s, today, ama } = await setUp();
    await take(s, s.teacher, today, [{ studentId: ama.id, status: "present", baseVersion: 0 }]);
    const results = await Promise.all([
      take(s, s.teacher, today, [{ studentId: ama.id, status: "absent", baseVersion: 1 }], "offline"),
      take(s, s.head, today, [{ studentId: ama.id, status: "late", baseVersion: 1 }]),
    ]);
    expect(results.map((r) => r.applied).sort()).toEqual([0, 1]);
    expect(results.flatMap((r) => r.conflicts)).toHaveLength(1);
  });

  it("skips a student who left the class before the marks arrived", async () => {
    const { s, today, ama } = await setUp();
    const other = await s.add("Esi", s.classB);
    const result = await take(s, s.owner, today, [
      { studentId: ama.id, status: "present", baseVersion: 0 },
      { studentId: other.id, status: "present", baseVersion: 0 },
    ]);
    expect(result).toMatchObject({ applied: 1, skipped: [other.id] });
  });
});

describe("where attendance shows", () => {
  it("feeds report cards (unless figures are typed in) and the parent view", async () => {
    const { s, today, ama, kofi } = await setUp();
    await setupDefaultSubjects(conn.app, s.owner);
    const days = [addDays(today, -3), addDays(today, -2), addDays(today, -1), today];
    const statuses = ["present", "late", "absent", "excused"] as const;
    for (const [i, date] of days.entries())
      await take(s, s.head, date, [
        { studentId: ama.id, status: statuses[i]!, baseVersion: 0 },
        { studentId: kofi.id, status: "present", baseVersion: 0 },
      ]);
    const summary = (await getClassAttendance(conn.app, s.teacher, s.classA, today))!;
    expect(summary.registers).toBe(4);
    expect(summary.students.find((x) => x.id === ama.id)!.totals).toEqual({
      open: 4,
      present: 1,
      late: 1,
      absent: 1,
      excused: 1,
    });

    const card = (await getReportCard(conn.app, s.teacher, s.termId, s.classA, ama.id))!;
    expect(card.snapshot.attendance).toEqual({ present: 2, open: 4 });
    expect(card.registers).toEqual({ present: 2, open: 4 });
    await saveReportRemarks(conn.app, s.teacher, s.termId, s.classA, ama.id, {
      attitude: "",
      conduct: "",
      interest: "",
      classTeacherRemark: "",
      daysPresent: "60",
      daysOpen: "62",
    });
    const overridden = (await getReportCard(conn.app, s.teacher, s.termId, s.classA, ama.id))!;
    expect(overridden.snapshot.attendance).toEqual({ present: 60, open: 62 });

    const phone = `024 ${randomInt(100, 1000)} ${randomInt(1000, 10000)}`;
    await addGuardian(conn.app, s.owner, ama.id, {
      fullName: "Akosua Mensah",
      phone,
      relationship: "mother",
    });
    const child = (await getParentChild(conn.app, normalizePhone(phone)!, s.tenant.slug, ama.id))!;
    expect(child.attendance).toMatchObject({
      totals: { open: 4, present: 1, late: 1, absent: 1, excused: 1 },
    });
    expect(child.attendance!.recent.map((r) => r.status)).toEqual(["excused", "absent", "late"]);
  });
});
