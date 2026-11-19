import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { listTeacherOptions, updateClass } from "@/server/academics/classes";
import type { AiConfig } from "@/server/ai/config";
import type { AiProvider } from "@/server/ai/types";
import { saveReportRemarks } from "@/server/assessment/report-cards";
import { getScoreSheet, saveScores } from "@/server/assessment/scores";
import { getAssessmentSetup, setupDefaultSubjects } from "@/server/assessment/setup";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { aiDrafts } from "@/server/db/schema";
import {
  discardDraft,
  draftAnnouncement,
  draftBoardReport,
  draftingAvailability,
  draftRemarks,
  resolveDraft,
} from "@/server/drafting/service";
import { getBoardSummary } from "@/server/dashboard/board-summary";
import { billTerm } from "@/server/fees/ledger";
import { renderBoardSummaryPdf } from "@/web/pdf/board-summary";
import { DEFAULT_AI_LIMITS } from "@/lib/ai-providers";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

// The gateway's settings are passed in (the platform's are global): a free provider, every task on.
const config: AiConfig = {
  enabled: true,
  provider: "groq",
  model: "scripted",
  baseUrl: null,
  apiKey: null,
  identifiableApproved: false,
  tasks: { assistant: true, remarks: true, announcements: true, board_report: true },
  limits: { ...DEFAULT_AI_LIMITS, userPerMinute: 60, userPerHour: 1000 },
};

/** Replies with `reply`, keeping what it was sent. */
function scripted(reply: string) {
  const sent: string[] = [];
  const provider: AiProvider = {
    id: "scripted",
    model: "scripted",
    respond: async ({ system, messages }) => {
      sent.push(system, String(messages[0]!.content));
      return {
        stop: "end",
        content: [{ type: "text", text: reply }],
        usage: { inputTokens: 50, outputTokens: 30, cachedInputTokens: 0 },
      };
    },
  };
  return { ai: { provider, config }, sent };
}

const drafts = (s: School) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
    tx.select().from(aiDrafts).where(eq(aiDrafts.tenantId, s.tenant.id)).orderBy(aiDrafts.createdAt),
  );

/** Basic 4A with GES subjects, the fixture's teacher as its class teacher, and Ama's marks in two subjects. */
async function setUp() {
  const s = await school();
  await setupDefaultSubjects(conn.app, s.owner);
  const teacher = (await listTeacherOptions(conn.app, s.owner)).find((t) => t.name === "Teacher")!;
  await updateClass(conn.app, s.owner, s.classA, {
    name: "Basic 4A",
    classTeacherMembershipId: teacher.membershipId,
  });
  const ama = (await s.add("Ama", s.classA)).id;
  const kofi = (await s.add("Kofi", s.classA)).id;
  const setup = (await getAssessmentSetup(conn.app, s.owner, s.termId))!;
  for (const [name, mark] of [
    ["Mathematics", { class: "25", exam: "40" }],
    ["English Language", { class: "20", exam: "30" }],
  ] as const) {
    const subjectId = setup.subjects.find((x) => x.name === name)!.id;
    const sheet = (await getScoreSheet(conn.app, s.owner, s.termId, s.classA, subjectId))!;
    const row = sheet.students.find((st) => st.id === ama)!;
    await saveScores(conn.app, s.owner, s.termId, s.classA, subjectId, {
      cells: (["class", "exam"] as const).map((key) => ({
        studentId: ama,
        key,
        original: row.scores[key] ?? "",
        value: mark[key],
      })),
    });
  }
  return { s, ama, kofi };
}

describe("report-card remarks (DRF-01)", () => {
  it("suggests remarks from the child's figures, sending no name, and records what the teacher did", async () => {
    const { s, ama } = await setUp();
    const { ai, sent } = scripted(
      '```json\n["{first name} works hard in Mathematics.", "{first name} should read more at home.", "{first name} is making steady progress."]\n```',
    );
    const ids = { termId: s.termId, classId: s.classA, studentId: ama };
    const result = await draftRemarks(conn.app, s.teacher, ids, ai);
    expect(result.suggestions).toEqual([
      "Ama works hard in Mathematics.",
      "Ama should read more at home.",
      "Ama is making steady progress.",
    ]);
    const prompt = sent.join("\n");
    expect(prompt).not.toMatch(/Ama|Mensah/);
    expect(prompt).not.toContain(s.tenant.name);
    expect(prompt).toContain('"subject":"Mathematics","total":45');

    // The teacher uses the first suggestion as it is: "used".
    await saveReportRemarks(conn.app, s.teacher, s.termId, s.classA, ama, {
      attitude: "",
      conduct: "",
      interest: "",
      classTeacherRemark: result.suggestions[0],
      daysPresent: "",
      daysOpen: "",
    });
    await resolveDraft(conn.app, s.teacher, result.draftId, result.suggestions[0]!);
    // A second draft, edited before saving: "changed"; a third set aside: "discarded".
    const second = await draftRemarks(conn.app, s.teacher, ids, ai);
    await resolveDraft(conn.app, s.teacher, second.draftId, "Ama works hard in Mathematics and English.");
    const third = await draftRemarks(conn.app, s.teacher, ids, ai);
    await discardDraft(conn.app, s.teacher, third.draftId);
    // Decided once: a later save does not change it.
    await resolveDraft(conn.app, s.teacher, result.draftId, "Something else.");
    const rows = await drafts(s);
    expect(rows.map((r) => [r.task, r.outcome, r.subjectId])).toEqual([
      ["remarks", "used", ama],
      ["remarks", "changed", ama],
      ["remarks", "discarded", ama],
    ]);
    expect(JSON.stringify(rows[0]!.sent)).not.toContain("Ama");
    await expect(
      withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
        tx.execute(sql`update ai_drafts set outcome = 'discarded' where outcome = 'used'`),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/decided once/) } });
  });

  it("is only for those who enter remarks for the class, and needs marks first", async () => {
    const { s, kofi } = await setUp();
    const { ai } = scripted('["{first name} tries hard."]');
    await expect(
      draftRemarks(conn.app, s.teacher, { termId: s.termId, classId: s.classA, studentId: kofi }, ai),
    ).rejects.toMatchObject({ code: "no_marks" });
    await expect(
      draftRemarks(conn.app, s.bursar, { termId: s.termId, classId: s.classA, studentId: kofi }, ai),
    ).rejects.toThrow(ForbiddenError);
    expect(await draftingAvailability(conn.app, s.bursar, "remarks")).toBeNull();
  });
});

describe("announcements (DRF-02)", () => {
  it("drafts a title and message from the points, with the school filled in here", async () => {
    const s = await school();
    const { ai, sent } = scripted(
      'Sure! {"title": "Sports day at {school}", "body": "Sports day is on Friday. Children should wear their house colours."}',
    );
    const draft = await draftAnnouncement(
      conn.app,
      s.owner,
      { points: "sports day friday, wear house colours", audience: "Every family" },
      ai,
    );
    expect(draft).toMatchObject({
      title: `Sports day at ${s.tenant.name}`,
      body: "Sports day is on Friday. Children should wear their house colours.",
    });
    expect(sent.join("\n")).not.toContain(s.tenant.name);
    await resolveDraft(conn.app, s.owner, draft.draftId, `${draft.title}\n\n${draft.body}`);
    expect((await drafts(s))[0]).toMatchObject({ task: "announcements", outcome: "used" });
    await expect(draftAnnouncement(conn.app, s.owner, { points: "hi" }, ai)).rejects.toMatchObject({
      code: "draft_invalid",
    });
  });
});

describe("board report (DRF-03)", () => {
  it("puts our figures into the prose and flags any the model wrote itself; for the Proprietor only", async () => {
    const s = await school();
    await s.add("Ama", s.classA);
    await billTerm(conn.app, s.bursar, s.termId);
    const { ai, sent } = scripted(
      "In {{term}} the school billed {{billed}} and collected {{collected}}. About 45% of families have paid. {{students}} students are in classes; {{nonsense}} is unknown.",
    );
    const report = await draftBoardReport(conn.app, s.owner, { termId: s.termId }, ai);
    expect(report.text).toBe(
      "In Term 1, 2026/2027 the school billed GH₵1,000.00 and collected GH₵0.00. About 45% of families have paid. 1 students are in classes; [not available] is unknown.",
    );
    expect(report.uncheckedFigures).toEqual(["45"]);
    expect(sent.join("\n")).toContain("{{billed}}: fees billed for the term = GH₵1,000.00");
    expect(sent.join("\n")).not.toContain(s.tenant.name);
    expect((await drafts(s))[0]).toMatchObject({ task: "board_report", outcome: null });
    await expect(draftBoardReport(conn.app, s.head, { termId: s.termId }, ai)).rejects.toThrow(
      ForbiddenError,
    );
    // The edited report prints above the figures, in the same PDF as the board summary.
    const summary = (await getBoardSummary(conn.app, s.owner, { termId: s.termId }))!;
    const pdf = await renderBoardSummaryPdf({
      cc: summary,
      schoolName: s.tenant.name,
      currency: "GHS",
      generatedOn: "2026-11-18",
      report: `${report.text}

A second paragraph.`,
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
