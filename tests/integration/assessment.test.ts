import { createHash, randomInt } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { listTeacherOptions, updateClass } from "@/server/academics/classes";
import {
  getReportCardFile,
  listReportCardBatches,
  processReportCardBatch,
  requestReportCardPrint,
} from "@/server/assessment/batches";
import {
  getClassOverview,
  getReportCard,
  publishReportCards,
  saveReportRemarks,
  withdrawReportCard,
} from "@/server/assessment/report-cards";
import { getScoreSheet, listAssessmentClasses, saveScores } from "@/server/assessment/scores";
import {
  createSubject,
  getAssessmentSetup,
  readScheme,
  saveAssessmentScheme,
  saveGradingScale,
  setupDefaultSubjects,
} from "@/server/assessment/setup";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import {
  assessmentScores,
  auditEvents,
  classes,
  enrolments,
  reportCardFiles,
  reportCards,
  students,
} from "@/server/db/schema";
import { DomainError } from "@/server/errors";
import { getParentChild, getParentReportCard } from "@/server/parents/portal";
import { addGuardian } from "@/server/students/guardians";
import { normalizePhone } from "@/lib/phone";
import { renderReportCardsPdf } from "@/web/pdf/report-card";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

/** Reads tenant tables in a test, with the school set (row-level security applies even to the owner role). */
const asSchool = <T>(s: School, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, fn);

const render = (cards: Parameters<typeof renderReportCardsPdf>[0]) => renderReportCardsPdf(cards);
const pageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;

/** A school with GES subjects, a teacher who is class teacher of Basic 4A, and three pupils in it. */
async function setUp() {
  const s = await school();
  await setupDefaultSubjects(conn.app, s.owner);
  const teacher = (await listTeacherOptions(conn.app, s.owner)).find((t) => t.name === "Teacher")!;
  await updateClass(conn.app, s.owner, s.classA, {
    name: "Basic 4A",
    classTeacherMembershipId: teacher.membershipId,
  });
  const ama = await s.add("Ama", s.classA);
  const kofi = await s.add("Kofi", s.classA);
  const yaw = await s.add("Yaw", s.classA);
  const setup = (await getAssessmentSetup(conn.app, s.owner, s.termId))!;
  const english = setup.subjects.find((x) => x.name === "English Language")!.id;
  const maths = setup.subjects.find((x) => x.name === "Mathematics")!.id;
  return { s, ama, kofi, yaw, english, maths, setup };
}

/** Saves marks as if typed on a fresh sheet (original values read from the sheet). */
async function enter(
  s: School,
  ctx: School["owner"],
  subjectId: string,
  marks: Record<string, { class?: string; exam?: string }>,
) {
  const sheet = (await getScoreSheet(conn.app, ctx, s.termId, s.classA, subjectId))!;
  const cells = sheet.students.flatMap((st) =>
    (["class", "exam"] as const).flatMap((key) => {
      const value = marks[st.id]?.[key];
      return value === undefined ? [] : [{ studentId: st.id, key, original: st.scores[key] ?? "", value }];
    }),
  );
  return saveScores(conn.app, ctx, s.termId, s.classA, subjectId, { cells });
}

describe("assessment setup", () => {
  it("adds the GES subjects per level once, and only academic leads change setup", async () => {
    const { s, setup } = await setUp();
    const basic4 = setup.levels.find((l) => l.name === "Basic 4")!;
    expect(basic4.subjects.map((x) => x.name)).toEqual([
      "English Language",
      "Mathematics",
      "Science",
      "Our World Our People",
      "History",
      "Religious and Moral Education",
      "Creative Arts",
      "Ghanaian Language",
      "French",
      "Computing",
      "Physical Education",
    ]);
    await expect(setupDefaultSubjects(conn.app, s.owner)).rejects.toThrow(DomainError);
    await expect(setupDefaultSubjects(conn.app, s.teacher)).rejects.toThrow(ForbiddenError);
    await expect(createSubject(conn.app, s.bursar, { name: "Latin", levelIds: [] })).rejects.toThrow(
      ForbiddenError,
    );
    await expect(
      createSubject(conn.app, s.owner, { name: "english language", levelIds: [] }),
    ).rejects.toMatchObject({
      field: "name",
    });

    // Defaults until saved; weights must add up to 100.
    expect((await readSchemeFor(s)).components.map((c) => [c.name, c.weight, c.outOf])).toEqual([
      ["Class score", 50, 50],
      ["Exam", 50, 100],
    ]);
    await expect(
      saveAssessmentScheme(conn.app, s.owner, s.termId, {
        components: [{ name: "Exam", weight: 70, outOf: 100 }],
        showPositions: false,
      }),
    ).rejects.toThrow("The weights add up to 70%, not 100%.");
    await expect(
      saveGradingScale(conn.app, s.owner, "primary", { bands: [{ min: 50, grade: "P", remark: "" }] }),
    ).rejects.toThrow(/start at 0/);
  });
});

const readSchemeFor = (s: School) =>
  withTenant(conn.app, { tenantId: s.tenant.id, userId: "" }, (tx) => readScheme(tx, s.tenant.id, s.termId));

describe("score entry", () => {
  it("lets the class teacher (and academic leads) enter marks, never another teacher's class", async () => {
    const { s, ama, english } = await setUp();
    // The teacher is class teacher of Basic 4A only.
    const list = (await listAssessmentClasses(conn.app, s.teacher, s.termId))!;
    expect(list.classes.map((c) => c.cls.name)).toEqual(["Basic 4A"]);
    expect(await getScoreSheet(conn.app, s.teacher, s.termId, s.classB, english)).toBeNull();
    await expect(getScoreSheet(conn.app, s.bursar, s.termId, s.classA, english)).rejects.toThrow(
      ForbiddenError,
    );

    const saved = await enter(s, s.teacher, english, { [ama.id]: { class: "42", exam: "75" } });
    expect(saved).toEqual({ saved: 2, conflicts: 0, locked: 0 });
    // The first mark fixes the term's assessment.
    expect((await readSchemeFor(s)).saved).toBe(true);
    const overview = (await getClassOverview(conn.app, s.teacher, s.termId, s.classA))!;
    const amaRow = overview.students.find((x) => x.id === ama.id)!;
    expect(amaRow.result.graded).toBe(1);
    expect(overview.subjects.find((x) => x.id === english)).toMatchObject({ complete: 1, entered: 1 });

    // Above the maximum, or more than one decimal, is refused.
    await expect(enter(s, s.teacher, english, { [ama.id]: { class: "51" } })).rejects.toThrow(/not valid/);
    await expect(enter(s, s.teacher, english, { [ama.id]: { exam: "60.25" } })).rejects.toThrow(/not valid/);

    const [audit] = await asSchool(s, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, s.tenant.id), eq(auditEvents.action, "assessment.scores_saved")))
        .orderBy(desc(auditEvents.occurredAt))
        .limit(1),
    );
    expect(audit!.metadata.marks).toEqual([
      { studentId: ama.id, part: "class", from: null, to: 420 },
      { studentId: ama.id, part: "exam", from: null, to: 750 },
    ]);
  });

  it("never silently overwrites a mark someone else changed after the sheet was opened", async () => {
    const { s, ama, kofi, english } = await setUp();
    const sheet = (await getScoreSheet(conn.app, s.teacher, s.termId, s.classA, english))!;
    // The head teacher opens the same sheet and saves first.
    await enter(s, s.head, english, { [ama.id]: { class: "30" } });
    const result = await saveScores(conn.app, s.teacher, s.termId, s.classA, english, {
      cells: [
        {
          studentId: ama.id,
          key: "class",
          original: sheet.students.find((x) => x.id === ama.id)!.scores.class!,
          value: "45",
        },
        { studentId: kofi.id, key: "class", original: "", value: "40" },
      ],
    });
    expect(result).toEqual({
      saved: 1,
      conflicts: 1,
      locked: 0,
      conflictCells: [{ studentId: ama.id, key: "class", yours: "45", theirs: "30" }],
    });
    const after = (await getScoreSheet(conn.app, s.teacher, s.termId, s.classA, english))!;
    expect(after.students.find((x) => x.id === ama.id)!.scores.class).toBe("30");
    expect(after.students.find((x) => x.id === kofi.id)!.scores.class).toBe("40");

    // Clearing a mark removes it.
    await enter(s, s.teacher, english, { [kofi.id]: { class: "" } });
    const cleared = (await getScoreSheet(conn.app, s.teacher, s.termId, s.classA, english))!;
    expect(cleared.students.find((x) => x.id === kofi.id)!.scores.class).toBe("");
  });

  it("keeps a part with marks, and an 'out of' below a mark entered, from being changed", async () => {
    const { s, ama, english } = await setUp();
    await enter(s, s.teacher, english, { [ama.id]: { class: "42", exam: "90" } });
    const scheme = await readSchemeFor(s);
    await expect(
      saveAssessmentScheme(conn.app, s.owner, s.termId, {
        components: [{ ...scheme.components[1]!, weight: 100 }],
        showPositions: false,
      }),
    ).rejects.toThrow(/Class score already has scores/);
    await expect(
      saveAssessmentScheme(conn.app, s.owner, s.termId, {
        components: [scheme.components[0]!, { ...scheme.components[1]!, outOf: 80 }],
        showPositions: false,
      }),
    ).rejects.toThrow(/above 80/);
    // Reweighting keeps the marks and recalculates: 42/50*30 + 90/100*70 = 25.2 + 63 = 88.
    await saveAssessmentScheme(conn.app, s.owner, s.termId, {
      components: [
        { ...scheme.components[0]!, weight: 30 },
        { ...scheme.components[1]!, weight: 70 },
      ],
      showPositions: true,
    });
    const report = (await getReportCard(conn.app, s.owner, s.termId, s.classA, ama.id))!;
    expect(report.snapshot.subjects[0]).toMatchObject({ name: "English Language", total: 88, grade: "A" });
    expect(report.snapshot.showPositions).toBe(true);
  });
});

describe("report cards", () => {
  it("publishes a frozen report card, locks its marks, and withdraws it with a reason", async () => {
    const { s, ama, kofi, english, maths } = await setUp();
    await enter(s, s.teacher, english, {
      [ama.id]: { class: "45", exam: "90" },
      [kofi.id]: { class: "40", exam: "80" },
    });
    await enter(s, s.teacher, maths, { [ama.id]: { class: "40", exam: "70" } });
    await saveReportRemarks(conn.app, s.teacher, s.termId, s.classA, ama.id, {
      attitude: "Hardworking",
      conduct: "Respectful",
      interest: "Reading",
      classTeacherRemark: "A steady term.",
      headTeacherRemark: "Ignored: teachers cannot write this.",
      daysPresent: "58",
      daysOpen: "62",
    });
    await expect(
      saveReportRemarks(conn.app, s.teacher, s.termId, s.classA, ama.id, {
        attitude: "",
        conduct: "",
        interest: "",
        classTeacherRemark: "",
        daysPresent: "70",
        daysOpen: "62",
      }),
    ).rejects.toThrow();
    await saveReportRemarks(conn.app, s.head, s.termId, s.classA, ama.id, {
      attitude: "Hardworking",
      conduct: "Respectful",
      interest: "Reading",
      classTeacherRemark: "A steady term.",
      headTeacherRemark: "Well done.",
      daysPresent: "58",
      daysOpen: "62",
    });
    await expect(publishReportCards(conn.app, s.teacher, s.termId, s.classA)).rejects.toThrow(ForbiddenError);

    const published = await publishReportCards(conn.app, s.head, s.termId, s.classA, {
      studentIds: [ama.id],
    });
    expect(published).toBe(1);
    expect(await publishReportCards(conn.app, s.head, s.termId, s.classA, { studentIds: [ama.id] })).toBe(0);
    const report = (await getReportCard(conn.app, s.teacher, s.termId, s.classA, ama.id))!;
    expect(report.status).toBe("published");
    expect(report.snapshot).toMatchObject({
      schoolName: s.tenant.name,
      term: { name: "Term 1", yearName: "2026/2027", nextTermBeginsOn: null },
      student: { className: "Basic 4A" },
      classSize: 3,
      attendance: { present: 58, open: 62 },
      remarks: { classTeacher: "A steady term.", headTeacher: "Well done." },
      classTeacherName: "Teacher",
      approvedBy: "Head",
    });
    expect(report.snapshot.subjects.slice(0, 2).map((x) => [x.total, x.grade])).toEqual([
      [90, "A"],
      [75, "P"],
    ]);

    // Marks behind a published card are locked: the service skips them and the database refuses them.
    expect(await enter(s, s.teacher, english, { [ama.id]: { class: "20" } })).toEqual({
      saved: 0,
      conflicts: 0,
      locked: 1,
    });
    await expect(
      withTenant(conn.app, { tenantId: s.tenant.id, userId: "" }, (tx) =>
        tx
          .update(assessmentScores)
          .set({ scoreTenths: 10 })
          .where(and(eq(assessmentScores.studentId, ama.id), eq(assessmentScores.componentKey, "class"))),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(conn.app, { tenantId: s.tenant.id, userId: "" }, (tx) =>
        tx.update(reportCards).set({ classTeacherRemark: "Edited" }).where(eq(reportCards.studentId, ama.id)),
      ),
    ).rejects.toThrow();
    await expect(
      saveReportRemarks(conn.app, s.head, s.termId, s.classA, ama.id, {
        attitude: "",
        conduct: "",
        interest: "",
        classTeacherRemark: "Changed",
        daysPresent: "",
        daysOpen: "",
      }),
    ).rejects.toThrow(/published/);
    // The term's assessment is fixed while anything is published.
    const scheme = await readSchemeFor(s);
    await expect(
      saveAssessmentScheme(conn.app, s.owner, s.termId, {
        components: scheme.components,
        showPositions: true,
      }),
    ).rejects.toThrow(/published/);

    // Other students' marks can still change; the published snapshot does not.
    await enter(s, s.teacher, english, { [kofi.id]: { exam: "100" } });
    const frozen = (await getReportCard(conn.app, s.teacher, s.termId, s.classA, ama.id))!;
    expect(frozen.snapshot.subjects[0]!.position).toBe(1);

    await expect(
      withdrawReportCard(conn.app, s.teacher, s.termId, s.classA, ama.id, { reason: "Typo" }),
    ).rejects.toThrow(ForbiddenError);
    await withdrawReportCard(conn.app, s.head, s.termId, s.classA, ama.id, {
      reason: "Exam mark entered wrongly",
    });
    expect((await enter(s, s.teacher, english, { [ama.id]: { class: "44" } })).saved).toBe(1);
    const draft = (await getReportCard(conn.app, s.teacher, s.termId, s.classA, ama.id))!;
    expect(draft.status).toBe("draft");
    expect(draft.remarks.classTeacherRemark).toBe("A steady term.");
    const [withdrawn] = await asSchool(s, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, s.tenant.id), eq(auditEvents.action, "report_card.withdrawn"))),
    );
    expect(withdrawn!.metadata.reason).toBe("Exam mark entered wrongly");
  });

  it("shows families only published report cards, and only of their own children", async () => {
    const { s, ama, kofi, english } = await setUp();
    const phone = `024 ${randomInt(100, 1000)} ${randomInt(1000, 10000)}`;
    await addGuardian(conn.app, s.owner, ama.id, {
      fullName: "Akosua Mensah",
      phone,
      relationship: "mother",
    });
    const e164 = normalizePhone(phone)!;
    await enter(s, s.teacher, english, { [ama.id]: { class: "45", exam: "90" } });

    const before = (await getParentChild(conn.app, e164, s.tenant.slug, ama.id))!;
    expect(before.reportCards).toEqual([]);
    await publishReportCards(conn.app, s.head, s.termId, s.classA);
    const after = (await getParentChild(conn.app, e164, s.tenant.slug, ama.id))!;
    expect(after.reportCards).toHaveLength(1);
    const card = await getParentReportCard(conn.app, e164, s.tenant.slug, ama.id, after.reportCards[0]!.id);
    expect(card?.student.name).toBe("Ama Mensah");
    // Kofi's card is published too, but this number does not reach him.
    const [kofiCard] = await asSchool(s, (tx) =>
      tx.select({ id: reportCards.id }).from(reportCards).where(eq(reportCards.studentId, kofi.id)),
    );
    expect(await getParentReportCard(conn.app, e164, s.tenant.slug, kofi.id, kofiCard!.id)).toBeNull();
    expect(await getParentReportCard(conn.app, e164, s.tenant.slug, ama.id, kofiCard!.id)).toBeNull();
  });
});

describe("bulk printing", () => {
  it("takes a print run once, even when two workers try at the same time", async () => {
    const { s, ama, english } = await setUp();
    await enter(s, s.teacher, english, { [ama.id]: { class: "45", exam: "90" } });
    await publishReportCards(conn.app, s.head, s.termId, s.classA);
    const batchId = await requestReportCardPrint(conn.app, s.teacher, s.termId, { classIds: [s.classA] });
    await expect(
      requestReportCardPrint(conn.app, s.teacher, s.termId, { classIds: [s.classB] }),
    ).rejects.toThrow("Class not found.");
    const [a, b] = await Promise.all([
      processReportCardBatch(conn.app, s.tenant.id, render, batchId),
      processReportCardBatch(conn.app, s.tenant.id, render, batchId),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const [batch] = await listReportCardBatches(conn.app, s.teacher);
    expect(batch).toMatchObject({ status: "done", files: [{ className: "Basic 4A", reportCount: 3 }] });
    const file = (await getReportCardFile(conn.app, s.teacher, batch!.files[0]!.id))!;
    expect(pageCount(file.pdf)).toBe(3);
    // Another teacher cannot download it; the head teacher can.
    expect(await getReportCardFile(conn.app, s.head, batch!.files[0]!.id)).not.toBeNull();
  });

  it("prints 400 report cards across 10 classes in the background, one PDF per class", async () => {
    const s = await school();
    await setupDefaultSubjects(conn.app, s.owner);
    const ids = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, async (tx) => {
      const [template] = await tx.select().from(classes).where(eq(classes.id, s.classA));
      const made = await tx
        .insert(classes)
        .values(
          Array.from({ length: 10 }, (_, i) => ({
            tenantId: s.tenant.id,
            levelId: template!.levelId,
            campusId: template!.campusId,
            name: `Basic 4 Stream ${i + 1}`,
          })),
        )
        .returning({ id: classes.id });
      const pupils = await tx
        .insert(students)
        .values(
          Array.from({ length: 400 }, (_, i) => ({
            tenantId: s.tenant.id,
            admissionNumber: `L${String(i).padStart(4, "0")}`,
            firstName: `Pupil${i}`,
            lastName: "Synthetic",
            sex: i % 2 ? ("male" as const) : ("female" as const),
          })),
        )
        .returning({ id: students.id });
      await tx.insert(enrolments).values(
        pupils.map((p, i) => ({
          tenantId: s.tenant.id,
          studentId: p.id,
          termId: s.termId,
          classId: made[i % 10]!.id,
        })),
      );
      return { classIds: made.map((c) => c.id), studentIds: pupils.map((p) => p.id) };
    });
    const setup = (await getAssessmentSetup(conn.app, s.owner, s.termId))!;
    const subjectIds = setup.levels.find((l) => l.name === "Basic 4")!.subjects.map((x) => x.id);
    await withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, async (tx) => {
      const rows = ids.studentIds.flatMap((studentId, i) =>
        subjectIds.flatMap((subjectId, j) => [
          {
            tenantId: s.tenant.id,
            termId: s.termId,
            studentId,
            subjectId,
            componentKey: "class",
            scoreTenths: 250 + ((i * 7 + j * 13) % 250),
          },
          {
            tenantId: s.tenant.id,
            termId: s.termId,
            studentId,
            subjectId,
            componentKey: "exam",
            scoreTenths: 400 + ((i * 11 + j * 3) % 600),
          },
        ]),
      );
      for (let i = 0; i < rows.length; i += 2000)
        await tx.insert(assessmentScores).values(rows.slice(i, i + 2000));
    });
    // Assessment is fixed by the first mark normally; these marks were inserted directly, so save it explicitly.
    await saveAssessmentScheme(conn.app, s.owner, s.termId, {
      components: (await readSchemeFor(s)).components,
      showPositions: true,
    });
    for (const classId of ids.classIds)
      expect(await publishReportCards(conn.app, s.head, s.termId, classId)).toBe(40);

    const batchId = await requestReportCardPrint(conn.app, s.head, s.termId, { classIds: ids.classIds });
    const started = Date.now();
    const done = await processReportCardBatch(conn.app, s.tenant.id, render, batchId);
    const seconds = (Date.now() - started) / 1000;
    expect(done).toEqual({ batchId, classes: 10 });
    console.log(`printed 400 report cards in ${seconds.toFixed(1)} s`);

    const files = await withTenant(conn.app, { tenantId: s.tenant.id, userId: "" }, (tx) =>
      tx.select().from(reportCardFiles).where(eq(reportCardFiles.batchId, batchId)),
    );
    expect(files).toHaveLength(10);
    for (const file of files) {
      expect(file.reportCount).toBe(40);
      expect(pageCount(file.pdf!)).toBe(40);
      expect(file.sha256).toBe(createHash("sha256").update(file.pdf!).digest("hex"));
    }
    const [published] = await asSchool(s, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(reportCards)
        .where(and(eq(reportCards.tenantId, s.tenant.id), eq(reportCards.status, "published"))),
    );
    expect(published!.n).toBe(400);
  }, 300_000);
});
