import { randomUUID } from "node:crypto";
import { and, eq, ilike } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { listTeacherOptions, updateClass } from "@/server/academics/classes";
import { getScoreSheet } from "@/server/assessment/scores";
import { getAssessmentSetup, setupDefaultSubjects } from "@/server/assessment/setup";
import { getRegister } from "@/server/attendance/registers";
import { withTenant } from "@/server/db/context";
import {
  academicYears,
  attendanceChanges,
  payments,
  students,
  syncOperations,
  terms,
} from "@/server/db/schema";
import { closePeriod } from "@/server/fees/period-lock";
import { saveOfflineReceiptsPreference } from "@/server/tenancy/preferences";
import { assignClass } from "@/server/students/service";
import { getSyncChanges } from "@/server/sync/changes";
import { SYNC_HANDLERS } from "@/server/sync/handlers";
import { applyOperations, type OperationOutcome } from "@/server/sync/protocol";
import type { TenantContext } from "@/server/tenancy/service";
import { addDays } from "@/lib/attendance";
import { todayIn } from "@/lib/format";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const asSchool = <T>(s: School, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, fn);

const send = (ctx: TenantContext, ...operations: object[]) =>
  applyOperations(conn.app, ctx, { operations }, SYNC_HANDLERS);
const op = (kind: string, payload: unknown, id: string = randomUUID()) => ({ id, kind, payload });
const one = async (ctx: TenantContext, operation: object): Promise<OperationOutcome> =>
  (await send(ctx, operation))[0]!;

/** A school whose term runs around today, with GES subjects and the teacher in charge of Basic 4A. */
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
  await setupDefaultSubjects(conn.app, s.owner);
  const teacher = (await listTeacherOptions(conn.app, s.owner)).find((t) => t.name === "Teacher")!;
  await updateClass(conn.app, s.owner, s.classA, {
    name: "Basic 4A",
    classTeacherMembershipId: teacher.membershipId,
  });
  const ama = (await s.add("Ama", s.classA)).id;
  const kofi = (await s.add("Kofi", s.classA)).id;
  const esi = (await s.add("Esi", s.classB)).id;
  const english = (await getAssessmentSetup(conn.app, s.owner, s.termId))!.subjects.find(
    (x) => x.name === "English Language",
  )!.id;
  return { s, today, ama, kofi, esi, english };
}

describe("the sync protocol", () => {
  it("applies a register once, however often it is sent, and returns conflicts for stale marks", async () => {
    const { s, today, ama, kofi } = await setUp();
    const register = op("attendance.register", {
      classId: s.classA,
      date: today,
      marks: [
        { studentId: ama, status: "present", baseVersion: 0 },
        { studentId: kofi, status: "absent", baseVersion: 0 },
      ],
    });
    const first = await one(s.teacher, register);
    expect(first).toMatchObject({ status: "applied", replayed: false, result: { applied: 2 } });
    const again = await one(s.teacher, register);
    expect(again).toMatchObject({ status: "applied", replayed: true, result: { applied: 2 } });
    const changes = await asSchool(s, (tx) =>
      tx.select().from(attendanceChanges).where(eq(attendanceChanges.tenantId, s.tenant.id)),
    );
    expect(changes).toHaveLength(2);

    // Made offline from version 0, but the head teacher has since marked Kofi: a conflict, not an overwrite.
    const stale = await one(
      s.teacher,
      op("attendance.register", {
        classId: s.classA,
        date: today,
        marks: [{ studentId: kofi, status: "late", baseVersion: 0 }],
      }),
    );
    expect(stale.status).toBe("conflict");
    expect(stale.status !== "rejected" && stale.result.conflicts).toEqual([
      expect.objectContaining({ studentId: kofi, yours: { status: "late", reason: null } }),
    ]);
    const view = (await getRegister(conn.app, s.teacher, s.classA, today))!;
    expect(view.students.find((x) => x.id === kofi)!.mark).toMatchObject({ status: "absent", version: 1 });
  });

  it("saves marks only where they are still what the device saw", async () => {
    const { s, ama, kofi, english } = await setUp();
    const cells = (values: [string, string, string][]) =>
      values.map(([studentId, original, value]) => ({ studentId, key: "class", original, value }));
    const payload = (c: ReturnType<typeof cells>) => ({
      termId: s.termId,
      classId: s.classA,
      subjectId: english,
      cells: c,
    });
    expect(await one(s.teacher, op("assessment.scores", payload(cells([[ama, "", "40"]]))))).toMatchObject({
      status: "applied",
      result: { saved: 1 },
    });
    // A second device read the sheet before that mark was entered.
    const outcome = await one(
      s.teacher,
      op(
        "assessment.scores",
        payload(
          cells([
            [ama, "", "35"],
            [kofi, "", "30"],
          ]),
        ),
      ),
    );
    expect(outcome).toMatchObject({
      status: "conflict",
      result: { saved: 1, conflicts: 1, conflictCells: [{ studentId: ama, yours: "35", theirs: "40" }] },
    });
    const sheet = (await getScoreSheet(conn.app, s.teacher, s.termId, s.classA, english))!;
    expect(sheet.students.find((x) => x.id === ama)!.scores.class).toBe("40");
    // Out of the teacher's classes: rejected, never retried into success.
    const theirs = await one(
      s.teacher,
      op("assessment.scores", {
        termId: s.termId,
        classId: s.classB,
        subjectId: english,
        cells: cells([[ama, "", "1"]]),
      }),
    );
    expect(theirs).toMatchObject({ status: "rejected", error: { code: "class_not_found" } });
  });

  it("registers a student once, and asks before adding a possible duplicate", async () => {
    const { s } = await setUp();
    const register = op("student.register", {
      firstName: "Abena",
      lastName: "Boateng",
      sex: "female",
      dateOfBirth: "2018-03-04",
      classId: s.classA,
      guardian: { fullName: "Akua Boateng", phone: "024 555 0199", relationship: "mother" },
    });
    const created = await one(s.owner, register);
    expect(created).toMatchObject({ status: "applied", result: { admissionNumber: expect.any(String) } });
    expect(await one(s.owner, register)).toMatchObject({ status: "applied", replayed: true });
    const count = async () =>
      (
        await asSchool(s, (tx) =>
          tx
            .select({ id: students.id })
            .from(students)
            .where(and(eq(students.tenantId, s.tenant.id), ilike(students.lastName, "boateng"))),
        )
      ).length;
    expect(await count()).toBe(1);

    // Entered on another device while offline: same child, spelled with different case and spacing.
    const twin = { firstName: " abena ", lastName: "BOATENG", sex: "female", dateOfBirth: "2018-03-04" };
    const asked = await one(s.owner, op("student.register", twin));
    expect(asked).toMatchObject({
      status: "conflict",
      result: { possibleDuplicates: [{ name: "Abena Boateng" }] },
    });
    expect(await count()).toBe(1);
    // A different child with the same name, confirmed by the person.
    expect(await one(s.owner, op("student.register", { ...twin, confirmDuplicate: true }))).toMatchObject({
      status: "applied",
    });
    expect(await count()).toBe(2);

    expect(
      await one(s.teacher, op("student.register", { firstName: "X", lastName: "Y", sex: "male" })),
    ).toMatchObject({
      status: "rejected",
      error: { code: "forbidden" },
    });
    expect(
      await one(s.owner, op("student.register", { firstName: "", lastName: "Y", sex: "x" })),
    ).toMatchObject({
      status: "rejected",
      error: { code: "invalid_input", fields: { firstName: expect.any(String) } },
    });
  });

  it("asks before adding a possible duplicate when no date of birth is given", async () => {
    const { s } = await setUp();
    const form = {
      firstName: "Esi",
      otherNames: "",
      lastName: "Offlineson",
      sex: "female",
      dateOfBirth: "",
      classId: "",
    };
    expect(await one(s.owner, op("student.register", form))).toMatchObject({ status: "applied" });
    expect(await one(s.owner, op("student.register", form))).toMatchObject({
      status: "conflict",
      result: { possibleDuplicates: [{ name: "Esi Offlineson" }] },
    });
  });

  it("never applies the same operation twice when it arrives on two connections at once", async () => {
    const { s } = await setUp();
    const register = op("student.register", { firstName: "Kwesi", lastName: "Arthur", sex: "male" });
    const outcomes = await Promise.all([
      one(s.owner, register),
      one(s.owner, register),
      one(s.owner, register),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["applied", "applied", "applied"]);
    expect(outcomes.filter((o) => !o.replayed)).toHaveLength(1);
    const rows = await asSchool(s, (tx) =>
      tx
        .select({ id: students.id })
        .from(students)
        .where(and(eq(students.tenantId, s.tenant.id), eq(students.lastName, "Arthur"))),
    );
    expect(rows).toHaveLength(1);
    const stored = await asSchool(s, (tx) =>
      tx.select().from(syncOperations).where(eq(syncOperations.id, register.id)),
    );
    expect(stored).toHaveLength(1);
  });

  it("refuses an operation id used for something else, and repeated ids in one batch", async () => {
    const { s, today, ama } = await setUp();
    const id = randomUUID();
    await one(s.owner, op("student.register", { firstName: "Efo", lastName: "Kumi", sex: "male" }, id));
    const reused = await one(
      s.owner,
      op(
        "attendance.register",
        { classId: s.classA, date: today, marks: [{ studentId: ama, status: "present", baseVersion: 0 }] },
        id,
      ),
    );
    expect(reused).toMatchObject({ status: "rejected", error: { code: "operation_id_reused" } });
    const same = op("student.register", { firstName: "A", lastName: "B", sex: "male" });
    await expect(send(s.owner, same, same)).rejects.toMatchObject({ code: "operation_repeated" });
  });
});

describe("payments taken offline", () => {
  it("need the Proprietor's permission, get the official receipt once, and keep the provisional number", async () => {
    const { s, today, ama, kofi } = await setUp();
    const payment = (studentId: string, provisional: string, extra: Record<string, unknown> = {}) =>
      op("payment.record", {
        studentId,
        amount: "150",
        method: "cash",
        paidOn: today,
        provisionalReference: provisional,
        ...extra,
      });
    expect(await one(s.bursar, payment(ama, "P-0A1B2C3D-0001"))).toMatchObject({
      status: "rejected",
      error: { code: "offline_receipts_off" },
    });
    await saveOfflineReceiptsPreference(conn.app, s.owner, { offlineReceiptsEnabled: true });
    const taken = payment(ama, "P-0A1B2C3D-0002");
    const first = await one(s.bursar, taken);
    expect(first).toMatchObject({
      status: "applied",
      result: { receiptNumber: expect.stringMatching(/^R\d{6}$/) },
    });
    expect(await one(s.bursar, taken)).toMatchObject({ status: "applied", replayed: true });
    const [row] = await asSchool(s, (tx) =>
      tx.select().from(payments).where(eq(payments.provisionalReference, "P-0A1B2C3D-0002")),
    );
    expect(row).toMatchObject({ studentId: ama, amountPesewas: 15_000 });
    expect(first.status !== "rejected" && first.result.receiptNumber).toBe(row!.receiptNumber);

    // A reference already used comes back for the person to confirm, not as a silent duplicate.
    await one(s.bursar, payment(kofi, "P-0A1B2C3D-0003", { method: "bank_deposit", reference: "SLIP-9" }));
    expect(
      await one(s.bursar, payment(kofi, "P-0A1B2C3D-0004", { method: "bank_deposit", reference: "SLIP-9" })),
    ).toMatchObject({
      status: "conflict",
      result: { duplicateReference: expect.stringContaining("SLIP-9") },
    });
    expect(
      await one(
        s.bursar,
        payment(kofi, "P-0A1B2C3D-0005", {
          method: "bank_deposit",
          reference: "SLIP-9",
          confirmDuplicate: true,
        }),
      ),
    ).toMatchObject({ status: "applied" });
    // Teachers cannot take payments; a closed period refuses back-dated ones.
    expect(await one(s.teacher, payment(ama, "P-0A1B2C3D-0006"))).toMatchObject({
      status: "rejected",
      error: { code: "forbidden" },
    });
    await closePeriod(conn.app, s.owner, { through: today });
    expect(await one(s.bursar, payment(ama, "P-0A1B2C3D-0007"))).toMatchObject({
      status: "rejected",
      error: { code: "period_locked" },
    });
  });
});

describe("the change feed", () => {
  it("starts with a snapshot of what the person may see, then sends changes and removals", async () => {
    const { s, today, ama, kofi, esi, english } = await setUp();
    const snapshot = await getSyncChanges(conn.app, s.teacher);
    expect(snapshot.snapshot).toBe(true);
    // The teacher sees only their own class's students.
    expect(snapshot.students.map((x) => x.id).sort()).toEqual([ama, kofi].sort());
    expect(snapshot.classes.length).toBeGreaterThanOrEqual(2);
    const ownerSnapshot = await getSyncChanges(conn.app, s.owner);
    expect(ownerSnapshot.students.map((x) => x.id)).toContain(esi);

    // Changes: Kofi moves to Basic 4B (out of the teacher's reach), a student joins Basic 4A, a register and marks.
    await assignClass(conn.app, s.owner, kofi, s.classB);
    const yaw = (await s.add("Yaw", s.classA)).id;
    await send(
      s.teacher,
      op("attendance.register", {
        classId: s.classA,
        date: today,
        marks: [{ studentId: ama, status: "present", baseVersion: 0 }],
      }),
    );
    await send(
      s.teacher,
      op("assessment.scores", {
        termId: s.termId,
        classId: s.classA,
        subjectId: english,
        cells: [{ studentId: ama, key: "class", original: "", value: "20" }],
      }),
    );
    const changes = await getSyncChanges(conn.app, s.teacher, snapshot.cursor);
    expect(changes.snapshot).toBe(false);
    expect(changes.students.map((x) => x.id)).toEqual([yaw]);
    expect(changes.removedStudents).toContain(kofi);
    expect(changes.registers).toEqual([{ classId: s.classA, date: today }]);
    expect(changes.marks).toEqual([{ classId: s.classA }]);
    // Nothing new: an empty page with the same position.
    const after = await getSyncChanges(conn.app, s.teacher, changes.cursor);
    expect(after).toMatchObject({ students: [], removedStudents: [], registers: [], marks: [], more: false });

    await expect(getSyncChanges(conn.app, s.teacher, "not-a-cursor")).rejects.toMatchObject({
      code: "cursor_invalid",
    });
  });
});
