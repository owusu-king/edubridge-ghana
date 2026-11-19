import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createAcademicYear, listAcademicYears } from "@/server/academics/calendar";
import { ForbiddenError } from "@/server/authz/permissions";
import { listCampuses } from "@/server/campuses/service";
import {
  getBoardSummary,
  getMovement,
  getOperationsNow,
  recordSummaryDownload,
} from "@/server/dashboard/board-summary";
import { getOwedToday, getTermFinance } from "@/server/dashboard/finance";
import { withTenant } from "@/server/db/context";
import { auditEvents, enrolments, reportCards } from "@/server/db/schema";
import { narrowToCampus } from "@/server/fees/access";
import { billTerm } from "@/server/fees/ledger";
import { recordPayment } from "@/server/fees/payments";
import { getTermPoint } from "@/server/insights/service";
import { reportMaintenance } from "@/server/inventory/maintenance";
import { renderBoardSummaryPdf } from "@/web/pdf/board-summary";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const asSchool = <T>(s: School, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, fn);

/**
 * Ama and Yaw in Basic 4A (Main) and Kofi in Basic 4B (East), billed GH₵1,000 each once Yaw has left, Ama paying GH₵400.
 * Last year's Term 3 had Ama, Yaw, Esi (who did not come back) and Kwame (who graduated). Yaw is withdrawn
 * during this term. Ama has a published report card averaging 60.
 */
async function setUp() {
  const s = await school();
  const campusList = await listCampuses(conn.app, s.owner);
  const main = campusList.find((c) => c.name === "Main")!;
  const east = campusList.find((c) => c.name === "East")!;
  await createAcademicYear(conn.app, s.owner, {
    name: "2025/2026",
    terms: [{ name: "Term 3", startsOn: "2026-04-20", endsOn: "2026-07-24" }],
  });
  const previous = (await listAcademicYears(conn.app, s.owner)).find((y) => y.name === "2025/2026")!.terms[0]!
    .id;
  const ama = (await s.add("Ama", s.classA)).id;
  const yaw = (await s.add("Yaw", s.classA)).id;
  await s.add("Kofi", s.classB);
  const esi = (await s.add("Esi", s.classA)).id;
  const kwame = (await s.add("Kwame", s.classA)).id;
  await asSchool(s, async (tx) => {
    // Esi and Kwame were only in last year's term.
    await tx
      .delete(enrolments)
      .where(and(eq(enrolments.termId, s.termId), sql`${enrolments.studentId} in (${esi}, ${kwame})`));
    await tx.insert(enrolments).values(
      [ama, yaw, esi, kwame].map((studentId) => ({
        tenantId: s.tenant.id,
        studentId,
        termId: previous,
        classId: s.classA,
      })),
    );
    await tx.execute(
      sql`update students set status = 'graduated', status_changed_at = '2026-07-24' where id = ${kwame}`,
    );
    await tx.execute(
      sql`update students set status = 'withdrawn', status_changed_at = '2026-10-01' where id = ${yaw}`,
    );
    await tx.insert(reportCards).values({
      tenantId: s.tenant.id,
      termId: s.termId,
      studentId: ama,
      status: "published",
      publishedAt: new Date(),
      snapshot: { overall: { average: 60, total: null, position: null, graded: 1 }, subjects: [] } as never,
    });
  });
  await billTerm(conn.app, s.bursar, s.termId);
  await recordPayment(conn.app, s.bursar, {
    studentId: ama,
    amount: "400",
    method: "cash",
    reference: "",
    paidOn: "2026-09-10",
    idempotencyKey: randomUUID(),
  });
  return { s, main, east, previous, ama };
}

describe("the Command Center's board summary, movement and operations", () => {
  it("prints the same money figures as the fee reports, for the school and for one campus", async () => {
    const { s, main, east } = await setUp();
    const cc = (await getBoardSummary(conn.app, s.owner, { termId: s.termId }))!;
    expect(cc.term).toMatchObject({ id: s.termId, label: "Term 1, 2026/2027" });
    expect(cc.campus).toBeNull();
    expect(cc.money!.finance).toEqual(await getTermFinance(conn.app, s.owner, s.termId));
    expect(cc.money!.owed).toEqual(await getOwedToday(conn.app, s.owner));
    expect(cc.money!.finance!.billedPesewas).toBe(200_000); // Ama and Kofi: Yaw had left before billing.
    expect(cc.money!.reconciliation).toMatchObject({ openDifferences: 0, refundsWaiting: 0 });
    expect(cc.results).toMatchObject({ averageScore: 60, publishedCards: 1 });

    // Campuses side by side add up to the whole school.
    expect(cc.comparison!.map((c) => c.name)).toEqual(["East", "Main"]);
    const sum = (k: "billedPesewas" | "collectedPesewas" | "enrolled") =>
      cc.comparison!.reduce((n, c) => n + (c.point?.[k] ?? 0), 0);
    const whole = (await getTermPoint(conn.app, s.owner, s.termId))!;
    expect(sum("billedPesewas")).toBe(whole.billedPesewas);
    expect(sum("collectedPesewas")).toBe(whole.collectedPesewas);
    expect(sum("enrolled")).toBe(whole.enrolled);

    // One campus: figures as a member of that campus sees them.
    const eastOnly = (await getBoardSummary(conn.app, s.owner, { termId: s.termId, campusId: east.id }))!;
    expect(eastOnly.campus).toEqual({ id: east.id, name: "East" });
    expect(eastOnly.money!.finance).toEqual(
      await getTermFinance(conn.app, narrowToCampus(s.owner, east.id), s.termId),
    );
    expect(eastOnly.money!.finance!.billedPesewas).toBe(100_000);
    const mainOnly = (await getBoardSummary(conn.app, s.owner, { termId: s.termId, campusId: main.id }))!;
    expect(mainOnly.money!.owed.totalPesewas).toBe(60_000);

    // A term that does not exist.
    expect(await getBoardSummary(conn.app, s.owner, { termId: randomUUID() })).toBeNull();
    expect(await getBoardSummary(conn.app, s.owner, { termId: "not-a-term" })).toBeNull();
  });

  it("counts enrolment movement and retention from last term", async () => {
    const { s, main } = await setUp();
    const movement = (await getMovement(conn.app, s.owner, s.termId))!;
    expect(movement.left).toEqual({ withdrawn: 1, transferred: 0, graduated: 0 });
    // Last term: Ama, Yaw, Esi (Kwame graduated); Ama and Yaw are placed this term.
    expect(movement.retention).toEqual({
      previous: 3,
      returned: 2,
      rate: 67,
      previousTerm: "Term 3, 2025/2026",
    });
    // Everyone last term was at Main, so East has nobody to retain.
    expect(
      (await getMovement(conn.app, narrowToCampus(s.owner, main.id), s.termId))!.retention,
    ).toMatchObject({
      previous: 3,
      returned: 2,
    });
    expect((await getMovement(conn.app, s.eastBursar, s.termId))?.retention).toMatchObject({ previous: 0 });
    expect(await getMovement(conn.app, s.owner, randomUUID())).toBeNull();
    await expect(getMovement(conn.app, s.teacher, s.termId)).rejects.toThrow(ForbiddenError);
  });

  it("counts operations now, only for people who see every campus", async () => {
    const { s } = await setUp();
    await reportMaintenance(conn.app, s.head, { title: "Leaking roof in Basic 4A", priority: "urgent" });
    expect(await getOperationsNow(conn.app, s.owner)).toMatchObject({
      maintenanceOpen: 1,
      maintenanceUrgent: 1,
      libraryOverdue: 0,
      visitorsOnSite: 0,
    });
    // Pages the person cannot open are left out; a campus-limited accountant gets no school-wide counts.
    expect(await getOperationsNow(conn.app, s.bursar)).toMatchObject({ leaveWaiting: null });
    expect(await getOperationsNow(conn.app, s.eastBursar)).toBeNull();
  });

  it("prints only the sections each role sees", async () => {
    const { s } = await setUp();
    const bursar = (await getBoardSummary(conn.app, s.bursar, { termId: s.termId }))!;
    expect(bursar.money).not.toBeNull();
    expect(bursar.results).toBeNull();

    // An accountant limited to East: East's money only, no campus comparison.
    const east = (await getBoardSummary(conn.app, s.eastBursar, { termId: s.termId }))!;
    expect(east.money!.finance!.billedPesewas).toBe(100_000);
    expect(east.comparison).toBeNull();

    await expect(getBoardSummary(conn.app, s.teacher, { termId: s.termId })).rejects.toThrow(ForbiddenError);
  });

  it("renders the board summary and records the download", async () => {
    const { s } = await setUp();
    const cc = (await getBoardSummary(conn.app, s.owner, { termId: s.termId }))!;
    const pdf = await renderBoardSummaryPdf({
      cc,
      schoolName: s.tenant.name,
      currency: "GHS",
      generatedOn: "2026-11-17",
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    await recordSummaryDownload(conn.app, s.owner, cc);
    const [event] = await asSchool(s, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.tenantId, s.tenant.id),
            eq(auditEvents.action, "command_center.summary_downloaded"),
          ),
        ),
    );
    expect(event).toMatchObject({
      entityId: s.termId,
      metadata: { term: "Term 1, 2026/2027", campus: null },
    });
    await expect(recordSummaryDownload(conn.app, s.teacher, cc)).rejects.toThrow(ForbiddenError);
  });
});
