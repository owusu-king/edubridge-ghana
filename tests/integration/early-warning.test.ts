import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createAcademicYear, listAcademicYears } from "@/server/academics/calendar";
import { listTeacherOptions, updateClass } from "@/server/academics/classes";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { academicYears, attendanceMarks, attendanceRegisters, reportCards, terms } from "@/server/db/schema";
import { countWaitingIndicators, getEarlyWarning, reviewIndicator } from "@/server/early-warning/indicators";
import {
  addPlanUpdate,
  closeSupportPlan,
  getSupportPlan,
  listSupportPlans,
  openSupportPlan,
} from "@/server/early-warning/plans";
import { getRules, saveRules } from "@/server/early-warning/rules";
import type { TenantContext } from "@/server/tenancy/service";
import { addDays } from "@/lib/attendance";
import { DEFAULT_SETTINGS } from "@/lib/early-warning";
import { todayIn } from "@/lib/format";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const asSchool = <T>(s: School, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, fn);

const card = (
  s: School,
  termId: string,
  studentId: string,
  average: number,
  subjects: [string, number][],
  daysAgo: number,
) => ({
  tenantId: s.tenant.id,
  termId,
  studentId,
  status: "published" as const,
  publishedAt: new Date(Date.now() - daysAgo * 86_400_000),
  snapshot: {
    overall: { average, total: null, position: null, graded: subjects.length },
    subjects: subjects.map(([name, total]) => ({ name, total })),
  } as never,
});

/**
 * The current term runs around today. The fixture's teacher is class teacher of Basic 4A (Main), where Ama has been
 * absent for the last three of eight registers and Kofi present throughout; Esi is in Basic 4B (East). Ama's
 * published average fell from 70 last term to 55 this term (published ten days ago), with two subjects below 50.
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
  await createAcademicYear(conn.app, s.owner, {
    name: "2025/2026",
    terms: [{ name: "Term 3", startsOn: addDays(today, -200), endsOn: addDays(today, -100) }],
  });
  const previous = (await listAcademicYears(conn.app, s.owner)).find((y) => y.name === "2025/2026")!.terms[0]!
    .id;
  const teacher = (await listTeacherOptions(conn.app, s.owner)).find((t) => t.name === "Teacher")!;
  await updateClass(conn.app, s.owner, s.classA, {
    name: "Basic 4A",
    classTeacherMembershipId: teacher.membershipId,
  });
  const ama = (await s.add("Ama", s.classA)).id;
  const kofi = (await s.add("Kofi", s.classA)).id;
  const esi = (await s.add("Esi", s.classB)).id;
  await asSchool(s, async (tx) => {
    for (let i = 8; i >= 1; i--) {
      const [r] = await tx
        .insert(attendanceRegisters)
        .values({ tenantId: s.tenant.id, classId: s.classA, termId: s.termId, date: addDays(today, -i) })
        .returning({ id: attendanceRegisters.id });
      await tx.insert(attendanceMarks).values([
        { tenantId: s.tenant.id, registerId: r!.id, studentId: ama, status: i <= 3 ? "absent" : "present" },
        { tenantId: s.tenant.id, registerId: r!.id, studentId: kofi, status: "present" },
      ]);
    }
    await tx.insert(reportCards).values([
      card(s, previous, ama, 70, [["Mathematics", 68]], 120),
      card(
        s,
        s.termId,
        ama,
        55,
        [
          ["Mathematics", 40],
          ["Integrated Science", 45],
          ["English Language", 80],
        ],
        10,
      ),
    ]);
  });
  return { s, today, ama, kofi, esi };
}

const keyOf = (ew: Awaited<ReturnType<typeof getEarlyWarning>>, rule: string) =>
  ew.indicators.find((i) => i.rule === rule)!.key;

describe("early-warning indicators (EWS-01)", () => {
  it("applies the school's rules to this term's records, with the evidence and the day each was raised", async () => {
    const { s, today, ama } = await setUp();
    const ew = await getEarlyWarning(conn.app, s.head);
    expect(ew.term).toMatchObject({ id: s.termId });
    expect(ew.indicators.map((i) => [i.rule, i.student.id])).toEqual(
      expect.arrayContaining([
        ["attendance_low", ama],
        ["absent_in_a_row", ama],
        ["average_down", ama],
        ["subjects_below", ama],
      ]),
    );
    expect(ew.indicators).toHaveLength(4);
    const by = (rule: string) => ew.indicators.find((i) => i.rule === rule)!;
    // Five of eight attended; the window first fell below 85% with the first absence (5 of 6 = 83%).
    expect(by("attendance_low").evidence[0]).toMatch(/^Attended 5 of 8 registers \(63%\)/);
    expect(by("attendance_low").raisedOn).toBe(addDays(today, -3));
    expect(by("absent_in_a_row")).toMatchObject({ raisedOn: addDays(today, -1) });
    expect(by("average_down").evidence[0]).toBe(
      "Report-card average 55.0 this term, down 15.0 from 70.0 in Term 3, 2025/2026.",
    );
    expect(by("subjects_below").evidence[0]).toBe(
      "Below 50 in 2 subjects on this term's report card: Mathematics (40), Integrated Science (45).",
    );
    // Raised ten days ago and not reviewed: waiting for the Head teacher.
    expect(by("average_down").waiting).toBe(true);
    expect(by("absent_in_a_row").waiting).toBe(false);
    expect(await countWaitingIndicators(conn.app, s.head)).toBe(4);
  });

  it("shows teachers their own classes only, and nobody outside the school's academic staff", async () => {
    const { s } = await setUp();
    const mine = await getEarlyWarning(conn.app, s.teacher);
    expect(mine.indicators).toHaveLength(4);
    expect(mine).toMatchObject({ seesAll: false, canReview: true });
    expect(await countWaitingIndicators(conn.app, s.teacher)).toBeNull();
    // Accountants, and EduBridge support even with the Proprietor's permissions, see nothing.
    await expect(getEarlyWarning(conn.app, s.bursar)).rejects.toThrow(ForbiddenError);
    const support = {
      ...s.owner,
      support: { grantId: "00000000-0000-0000-0000-000000000001" },
    } as TenantContext;
    await expect(getEarlyWarning(conn.app, support)).rejects.toThrow(ForbiddenError);
    // The Proprietor sees every class, but reviews are for teachers and the Head teacher.
    expect((await getEarlyWarning(conn.app, s.owner)).canReview).toBe(false);
  });

  it("follows the school's rules", async () => {
    const { s } = await setUp();
    expect(await getRules(conn.app, s.teacher)).toEqual(DEFAULT_SETTINGS);
    await saveRules(conn.app, s.head, {
      ...DEFAULT_SETTINGS,
      absencesOn: false,
      passMark: "41",
      subjectsCount: 1,
    });
    const ew = await getEarlyWarning(conn.app, s.head);
    expect(ew.indicators.map((i) => i.rule).sort()).toEqual([
      "attendance_low",
      "average_down",
      "subjects_below",
    ]);
    expect(ew.indicators.find((i) => i.rule === "subjects_below")!.evidence[0]).toMatch(
      /Mathematics \(40\)\.$/,
    );
    await expect(saveRules(conn.app, s.head, { ...DEFAULT_SETTINGS, passMark: 95 })).rejects.toMatchObject({
      code: "rules_invalid",
      message: "The pass mark must be at most 80.",
    });
    await expect(saveRules(conn.app, s.teacher, { ...DEFAULT_SETTINGS })).rejects.toThrow(ForbiddenError);
  });
});

describe("reviews and support plans (EWS-02, EWS-03)", () => {
  it("reviews each indicator once: no action, a support plan, or a referral the Head teacher acts on", async () => {
    const { s, today, ama } = await setUp();
    let ew = await getEarlyWarning(conn.app, s.teacher);
    await expect(
      reviewIndicator(conn.app, s.teacher, {
        key: keyOf(ew, "attendance_low"),
        outcome: "no_action",
        reason: "",
      }),
    ).rejects.toMatchObject({ code: "review_invalid" });
    await reviewIndicator(conn.app, s.teacher, {
      key: keyOf(ew, "attendance_low"),
      outcome: "no_action",
      reason: "Ama was in hospital; her mother called the school.",
    });
    const { supportPlanId } = await reviewIndicator(conn.app, s.teacher, {
      key: keyOf(ew, "absent_in_a_row"),
      outcome: "support_plan",
      reason: "Third absence this month without a call.",
      goal: "Ama attends every day",
      actions: "Call home after any absence; weekly check-in with the class teacher.",
      responsible: "Class teacher",
      reviewOn: addDays(today, 14),
    });
    expect(supportPlanId).toEqual(expect.any(String));
    await reviewIndicator(conn.app, s.teacher, {
      key: keyOf(ew, "average_down"),
      outcome: "referred",
      reason: "Her marks fell in every subject; the Head teacher should meet the family.",
    });
    await expect(
      reviewIndicator(conn.app, s.head, {
        key: keyOf(ew, "average_down"),
        outcome: "no_action",
        reason: "Fine.",
      }),
    ).rejects.toMatchObject({ code: "already_reviewed" });
    await expect(
      reviewIndicator(conn.app, s.owner, {
        key: keyOf(ew, "subjects_below"),
        outcome: "no_action",
        reason: "Fine.",
      }),
    ).rejects.toThrow(ForbiddenError);

    ew = await getEarlyWarning(conn.app, s.head);
    expect(ew.indicators.find((i) => i.rule === "attendance_low")!.review).toMatchObject({
      outcome: "no_action",
      by: "Teacher",
    });
    expect(ew.referrals).toEqual([
      expect.objectContaining({ rule: "average_down", by: "Teacher", planOpened: false }),
    ]);
    expect(await countWaitingIndicators(conn.app, s.head)).toBe(1);
    // The Head teacher opens a plan for the referred student.
    await openSupportPlan(conn.app, s.head, {
      studentId: ama,
      goal: "Ama's marks recover",
      actions: "Meet the family; extra reading support twice a week.",
      responsible: "Head teacher",
      reviewOn: addDays(today, 21),
    });
    expect((await getEarlyWarning(conn.app, s.head)).referrals[0]!.planOpened).toBe(true);

    // Reviews cannot be changed or removed, by any role.
    await expect(
      asSchool(s, (tx) => tx.execute(sql`delete from early_warning_reviews`)),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/insert-only/) } });
  });

  it("keeps a plan's history: updates added, closed once with an outcome", async () => {
    const { s, today, ama, esi } = await setUp();
    const plan = await openSupportPlan(conn.app, s.teacher, {
      studentId: ama,
      goal: "Ama attends every day",
      actions: "Call home after any absence.",
      responsible: "Class teacher",
      reviewOn: addDays(today, 7),
    });
    // Only students in the teacher's own classes.
    await expect(
      openSupportPlan(conn.app, s.teacher, {
        studentId: esi,
        goal: "Esi settles in",
        actions: "Buddy in class.",
        responsible: "Class teacher",
        reviewOn: addDays(today, 7),
      }),
    ).rejects.toMatchObject({ code: "student_not_found" });
    await addPlanUpdate(conn.app, s.teacher, plan, {
      note: "Called home twice; attendance better this week.",
      reviewOn: addDays(today, 28),
    });
    let detail = (await getSupportPlan(conn.app, s.head, plan))!;
    expect(detail).toMatchObject({
      reviewOn: addDays(today, 28),
      closed: false,
      overdue: false,
      canChange: true,
    });
    expect(detail.updates).toEqual([
      expect.objectContaining({ note: "Called home twice; attendance better this week." }),
    ]);
    expect((await listSupportPlans(conn.app, s.teacher)).map((p) => p.id)).toEqual([plan]);

    await closeSupportPlan(conn.app, s.teacher, plan, { outcome: "Full attendance for four weeks." });
    detail = (await getSupportPlan(conn.app, s.teacher, plan))!;
    expect(detail).toMatchObject({
      closed: true,
      outcome: "Full attendance for four weeks.",
      canChange: false,
    });
    await expect(closeSupportPlan(conn.app, s.teacher, plan, { outcome: "Again." })).rejects.toMatchObject({
      code: "plan_closed",
    });
    await expect(addPlanUpdate(conn.app, s.teacher, plan, { note: "Late note." })).rejects.toMatchObject({
      code: "plan_closed",
    });
    // A plan is never edited or deleted, by any role.
    await expect(
      asSchool(s, (tx) => tx.execute(sql`update support_plans set goal = 'changed'`)),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/never edited/) } });
    await expect(asSchool(s, (tx) => tx.execute(sql`delete from support_plans`))).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/never edited or deleted/) },
    });
    // Nobody outside the student's class teacher and academic leads.
    await expect(getSupportPlan(conn.app, s.bursar, plan)).rejects.toThrow(ForbiddenError);
  });
});
