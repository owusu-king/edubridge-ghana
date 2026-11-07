import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createAcademicYear, listAcademicYears } from "@/server/academics/calendar";
import { setupDefaultSubjects } from "@/server/assessment/setup";
import { syncRegister } from "@/server/attendance/registers";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { enrolments, reportCards, terms } from "@/server/db/schema";
import { billTerm } from "@/server/fees/ledger";
import { recordPayment } from "@/server/fees/payments";
import {
  getAttendanceInsights,
  getFinanceInsights,
  getLevelPerformance,
  getOperationsInsights,
  getStudentTrends,
  getTermTrends,
} from "@/server/insights/service";
import { todayIn } from "@/lib/format";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const asSchool = <T>(s: School, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, fn);

const card = (
  s: School,
  termId: string,
  studentId: string,
  average: number,
  subjects: [string, number][],
) => ({
  tenantId: s.tenant.id,
  termId,
  studentId,
  status: "published" as const,
  publishedAt: new Date(),
  snapshot: {
    overall: { average, total: null, position: null, graded: subjects.length },
    subjects: subjects.map(([name, total]) => ({ name, total })),
  } as never,
});

/**
 * Last year's Term 3 (Ama and Yaw in Basic 4A) and this year's Term 1 (Ama, Yaw and newcomer Kofi), with
 * published report cards: Ama falls from 70 to 55, Yaw stays at 80, Kofi starts at 45.
 */
async function setUp() {
  const s = await school();
  await createAcademicYear(conn.app, s.owner, {
    name: "2025/2026",
    terms: [{ name: "Term 3", startsOn: "2026-04-20", endsOn: "2026-07-24" }],
  });
  const previous = (await listAcademicYears(conn.app, s.owner)).find((y) => y.name === "2025/2026")!.terms[0]!
    .id;
  const ama = (await s.add("Ama", s.classA)).id;
  const yaw = (await s.add("Yaw", s.classA)).id;
  const kofi = (await s.add("Kofi", s.classA)).id;
  await asSchool(s, async (tx) => {
    await tx.insert(enrolments).values(
      [ama, yaw].map((studentId) => ({
        tenantId: s.tenant.id,
        studentId,
        termId: previous,
        classId: s.classA,
      })),
    );
    await tx.insert(reportCards).values([
      card(s, previous, ama, 70, [
        ["Mathematics", 72],
        ["English Language", 68],
      ]),
      card(s, previous, yaw, 80, [
        ["Mathematics", 82],
        ["English Language", 78],
      ]),
      card(s, s.termId, ama, 55, [
        ["Mathematics", 50],
        ["English Language", 60],
      ]),
      card(s, s.termId, yaw, 80, [
        ["Mathematics", 81],
        ["English Language", 79],
      ]),
      card(s, s.termId, kofi, 45, [
        ["Mathematics", 40],
        ["English Language", 50],
      ]),
    ]);
  });
  return { s, previous, ama, yaw, kofi };
}

describe("school insights", () => {
  it("follow enrolment, results and money term by term", async () => {
    const { s, previous, kofi } = await setUp();
    await billTerm(conn.app, s.bursar, s.termId);
    await recordPayment(conn.app, s.bursar, {
      studentId: kofi,
      amount: "600",
      method: "cash",
      reference: "",
      paidOn: (await asSchool(s, (tx) => tx.select().from(terms).where(eq(terms.id, s.termId))))[0]!.startsOn,
      idempotencyKey: randomUUID(),
    });
    const trends = await getTermTrends(conn.app, s.owner);
    expect(trends.map((t) => t.termId)).toEqual([previous, s.termId]);
    expect(trends[0]).toMatchObject({
      enrolled: 2,
      newStudents: 2,
      averageScore: 75,
      publishedCards: 2,
      billedPesewas: 0,
    });
    expect(trends[1]).toMatchObject({
      enrolled: 3,
      newStudents: 1,
      averageScore: 60,
      publishedCards: 3,
      billedPesewas: 300_000,
      collectedPesewas: 60_000,
      collectionRate: 20,
    });
    // The accountant sees money but not results; teachers do not see insights.
    const forBursar = await getTermTrends(conn.app, s.bursar);
    expect(forBursar[1]).toMatchObject({ averageScore: null, billedPesewas: 300_000 });
    await expect(getTermTrends(conn.app, s.teacher)).rejects.toThrow(ForbiddenError);
  });

  it("find declining students and those who may need support, and compare a level across terms", async () => {
    const { s, ama, kofi } = await setUp();
    const { declining, support } = await getStudentTrends(conn.app, s.head);
    expect(declining).toEqual([
      expect.objectContaining({
        studentId: ama,
        change: -15,
        previous: expect.objectContaining({ average: 70 }),
      }),
    ]);
    expect(support.map((x) => x.studentId)).toEqual([kofi]);
    expect((await getStudentTrends(conn.app, s.bursar)).declining).toEqual([]);

    const [basic4] = await getLevelPerformance(conn.app, s.head, { levelName: "basic 4" });
    expect(basic4!.levelName).toBe("Basic 4");
    expect(basic4!.terms.map((t) => t.average)).toEqual([75, 60]);
    expect(basic4!.subjects.find((x) => x.name === "Mathematics")!.averages).toEqual([77, 57]);
  });

  it("show absence by class, chronic absence and repeated lateness", async () => {
    const { s, ama, yaw, kofi } = await setUp();
    const today = todayIn(s.tenant.timezone);
    const dates = ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18"].filter(
      (d) => d <= today,
    );
    for (const [i, date] of dates.entries())
      await syncRegister(conn.app, s.head, {
        classId: s.classA,
        date,
        source: "online",
        marks: [
          { studentId: ama, status: "present", baseVersion: 0 },
          { studentId: yaw, status: i < 3 ? "late" : "present", baseVersion: 0 },
          { studentId: kofi, status: i < 2 ? "absent" : "present", baseVersion: 0 },
        ],
      });
    const insights = await getAttendanceInsights(conn.app, s.head);
    expect(insights.byClass[0]).toMatchObject({ className: "Basic 4A", marks: 15, absent: 2, late: 3 });
    expect(insights.chronic.map((x) => x.studentId)).toEqual([kofi]);
    // Lateness counts the last 30 days only.
    const recent = dates.filter((d) => d > new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
    expect(insights.lateness.length).toBe(recent.length >= 3 ? 1 : 0);
  });

  it("show money by level and scheduled plan instalments, and the registers and marks still missing", async () => {
    const { s } = await setUp();
    await billTerm(conn.app, s.bursar, s.termId);
    const finance = await getFinanceInsights(conn.app, s.bursar);
    expect(finance.byLevel).toEqual([
      expect.objectContaining({
        levelName: "Basic 4",
        students: 3,
        billedPesewas: 300_000,
        owedPesewas: 300_000,
      }),
    ]);
    expect((await getFinanceInsights(conn.app, s.head)).byLevel.length).toBeGreaterThan(0);
    // An accountant limited to the East campus sees none of Main campus's Basic 4A.
    expect((await getFinanceInsights(conn.app, s.eastBursar)).byLevel).toEqual([]);
    expect((await getTermTrends(conn.app, s.eastBursar)).at(-1)).toMatchObject({
      billedPesewas: 0,
      enrolled: 0,
    });

    await setupDefaultSubjects(conn.app, s.owner);
    const ops = await getOperationsInsights(conn.app, s.head);
    expect(ops.marksOutstanding).toEqual([
      expect.objectContaining({ className: "Basic 4A", completeSheets: 0 }),
    ]);
    expect((await getOperationsInsights(conn.app, s.bursar)).missingRegisters).toEqual([]);
  });
});
