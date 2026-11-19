import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { uncheckedFigures } from "../../lib/answer-check";
import type { AiTask } from "../../lib/ai-providers";
import { extractJson, fillFigures, fillNames, sameText } from "../../lib/drafting";
import { countryName } from "../../lib/format";
import { formatMoney } from "../../lib/money";
import { AiUnavailableError, aiAvailability, openAiSession } from "../ai/gateway";
import type { AiProvider } from "../ai/types";
import type { AiConfig } from "../ai/config";
import { getReportCard } from "../assessment/report-cards";
import { allowed, assertAllowed, type Permission } from "../authz/permissions";
import { getBoardSummary } from "../dashboard/board-summary";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { aiDrafts } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";

/**
 * AI drafting (R5-5, DRF-01 to DRF-05): drafts a person edits before use, through the AI gateway (its flags, limits
 * and usage). Nothing a draft is about is named to the provider: the model writes placeholders that our server fills
 * in, and figures in a board report are ours. Every draft is kept with its outcome, decided once.
 */

type DraftTask = Extract<AiTask, "remarks" | "announcements" | "board_report">;

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

/** The permissions a draft needs besides the work's own (checked by each draft). */
const PERMISSION: Record<DraftTask, Permission> = {
  remarks: "drafting.use",
  announcements: "drafting.use",
  board_report: "drafting.board_report",
};
const WORK: Record<DraftTask, Permission> = {
  remarks: "assessment.enter",
  announcements: "communication.send",
  board_report: "drafting.board_report",
};

/** Tests: a scripted provider, and the gateway settings to use instead of the platform's. */
export type DraftAi = { provider: AiProvider; config?: AiConfig } | null;

/** Whether the person may draft this kind of work now, and if not, why (for the form to say). */
export async function draftingAvailability(
  database: Database,
  ctx: TenantContext,
  task: DraftTask,
): Promise<{ available: boolean; message: string | null } | null> {
  if (!allowed(ctx, PERMISSION[task]) || !allowed(ctx, WORK[task])) return null;
  const a = await aiAvailability(database, ctx, task);
  return { available: a.available, message: a.message };
}

/** One call to the model for a draft, through the gateway; a plain message when AI cannot help. */
async function write(
  database: Database,
  ctx: TenantContext,
  task: DraftTask,
  system: string,
  prompt: string,
  ai: DraftAi,
): Promise<{ text: string; provider: string; model: string }> {
  try {
    const session = await openAiSession(database, ctx, task, ai ?? {});
    const response = await session.respond({
      system,
      messages: [{ role: "user", content: prompt }],
      tools: [],
    });
    const text = response.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (response.stop === "refusal" || !text)
      throw new DomainError("draft_failed", "The AI could not write a draft for this. Write it yourself.");
    return { text, provider: session.provider, model: session.model };
  } catch (error) {
    if (error instanceof AiUnavailableError)
      throw new DomainError(error.code, `Drafting is not available: ${error.message}`);
    throw error;
  }
}

async function keep(
  database: Database,
  ctx: TenantContext,
  row: {
    task: DraftTask;
    provider: string;
    model: string;
    sent: Record<string, unknown>;
    drafts: string[];
    subjectId?: string;
  },
): Promise<string> {
  const [inserted] = await withTenant(database, scope(ctx), (tx) =>
    tx
      .insert(aiDrafts)
      .values({ tenantId: ctx.tenant.id, userId: ctx.userId, subjectId: row.subjectId ?? null, ...row })
      .returning({ id: aiDrafts.id }),
  );
  return inserted!.id;
}

// ---- Report-card remarks (DRF-01) -------------------------------------------------------------------------------

export interface RemarkDrafts {
  draftId: string;
  suggestions: string[];
}

/**
 * Three suggested class-teacher remarks for a draft report card, from the child's own figures. The provider sees no
 * name, admission number or school: the model writes {first name}, filled in here.
 */
export async function draftRemarks(
  database: Database,
  ctx: TenantContext,
  input: { termId: string; classId: string; studentId: string },
  ai: DraftAi = null,
): Promise<RemarkDrafts> {
  assertAllowed(ctx, "drafting.use");
  const card = await getReportCard(database, ctx, input.termId, input.classId, input.studentId);
  if (!card) throw new DomainError("student_not_found", "Student not found in this class.");
  if (card.status === "published")
    throw new DomainError(
      "report_published",
      "This report card is published. Withdraw it to change the remark.",
    );
  const snap = card.snapshot;
  const sent = {
    level: snap.student.levelName,
    average: snap.overall.average,
    subjects: snap.subjects
      .filter((s) => s.total !== null)
      .map((s) => ({ subject: s.name, total: s.total, grade: s.grade })),
    attendance: card.registers,
    attitude: card.remarks.attitude || null,
    conduct: card.remarks.conduct || null,
    interest: card.remarks.interest || null,
  };
  if (!sent.subjects.length)
    throw new DomainError("no_marks", "Enter this term's marks first: suggestions come from them.");
  const { text, provider, model } = await write(
    database,
    ctx,
    "remarks",
    [
      `You help a class teacher at a school in ${countryName(ctx.tenant.countryCode)} write the class teacher's remark on a pupil's end-of-term report card.`,
      "Write three different remarks in plain British English, each one or two sentences and at most 300 characters: honest, warm and specific to the figures, with one thing to work on where the figures show it.",
      "Refer to the pupil only as {first name} (exactly that). Do not mention their position, other pupils, family, health or anything not in the figures. Do not repeat the marks.",
      'Reply with JSON only: an array of three strings, e.g. ["…", "…", "…"].',
    ].join("\n"),
    JSON.stringify(sent),
    ai,
  );
  const parsed = extractJson(text);
  const raw = Array.isArray(parsed)
    ? parsed.filter((x): x is string => typeof x === "string")
    : text.split(/\n+/).filter((l) => l.trim().length > 20);
  const firstName = snap.student.name.split(/\s+/)[0] ?? "";
  const suggestions = raw
    .map((r) => fillNames(r.replace(/^[-*\d.)\s]+/, ""), { "first name": firstName }).slice(0, 500))
    .filter(Boolean)
    .slice(0, 3);
  if (!suggestions.length)
    throw new DomainError("draft_failed", "The AI did not write a usable remark. Write it yourself.");
  const draftId = await keep(database, ctx, {
    task: "remarks",
    provider,
    model,
    sent,
    drafts: suggestions,
    subjectId: input.studentId,
  });
  return { draftId, suggestions };
}

// ---- Announcements (DRF-02) --------------------------------------------------------------------------------------

const announcementInput = z.object({
  points: z
    .string()
    .trim()
    .min(10, "Write a few words about what the announcement should say.")
    .max(1000, "Keep the points to 1,000 characters."),
  audience: z.string().trim().max(120).default("Every family"),
});

export interface AnnouncementDraft {
  draftId: string;
  title: string;
  body: string;
}

/** A title and message from the person's points; the school is written {school} and filled in here. */
export async function draftAnnouncement(
  database: Database,
  ctx: TenantContext,
  input: Record<string, unknown>,
  ai: DraftAi = null,
): Promise<AnnouncementDraft> {
  assertAllowed(ctx, "drafting.use");
  assertAllowed(ctx, "communication.send");
  const parsed = announcementInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new DomainError("draft_invalid", issue.message, "points");
  }
  const { points, audience } = parsed.data;
  const { text, provider, model } = await write(
    database,
    ctx,
    "announcements",
    [
      `You draft announcements from a school in ${countryName(ctx.tenant.countryCode)} to its families.`,
      "Plain, warm, brief British English. A title of at most 90 characters and a message of at most 1,500 characters.",
      "Refer to the school as {school}. Use only the points given: never invent dates, times, amounts, names or events.",
      'Reply with JSON only: {"title": "…", "body": "…"}.',
    ].join("\n"),
    `Audience: ${audience}\nPoints:\n${points}`,
    ai,
  );
  const json = extractJson(text) as { title?: unknown; body?: unknown } | null;
  const values = { school: ctx.tenant.name };
  const title = fillNames(typeof json?.title === "string" ? json.title : "", values).slice(0, 100);
  const body = fillNames(typeof json?.body === "string" ? json.body : text, values).slice(0, 2000);
  if (!title || !body)
    throw new DomainError("draft_failed", "The AI did not write a usable draft. Write it yourself.");
  const draftId = await keep(database, ctx, {
    task: "announcements",
    provider,
    model,
    sent: { audience, points },
    drafts: [`${title}\n\n${body}`],
  });
  return { draftId, title, body };
}

// ---- Board report (DRF-03) ---------------------------------------------------------------------------------------

export interface BoardReportDraft {
  draftId: string;
  text: string;
  /** Figures the model wrote itself instead of a placeholder, not matching ours. */
  uncheckedFigures: string[];
}

const pct = (v: number | null | undefined) => (v === null || v === undefined ? null : `${v}%`);

/** The Command Center figures a board report may use, as our code formats them (only those the records have). */
async function boardFigures(database: Database, ctx: TenantContext, termId: string, campusId: string | null) {
  const summary = await getBoardSummary(database, ctx, { termId, campusId });
  if (!summary) throw new DomainError("term_not_found", "Choose a term.");
  const money = (minor: number | null | undefined) =>
    minor === null || minor === undefined ? null : formatMoney(minor, ctx.tenant.currencyCode);
  const f = summary.money?.finance;
  const m = summary.enrolment?.movement;
  const all: Record<string, { label: string; value: string | null }> = {
    term: { label: "the term", value: summary.term.label },
    billed: { label: "fees billed for the term", value: money(f?.billedPesewas) },
    collected: { label: "fees collected in the term", value: money(f?.collected?.totalPesewas ?? null) },
    collection_rate: { label: "collection rate", value: pct(f?.collectionRate) },
    owed_today: {
      label: "owed by families today, every term",
      value: money(summary.money?.owed.totalPesewas),
    },
    students: {
      label: "students placed in classes",
      value: summary.enrolment?.enrolment ? String(summary.enrolment.enrolment.total) : null,
    },
    applications: { label: "applications received this term", value: m ? String(m.applications) : null },
    admitted: { label: "students admitted this term", value: m ? String(m.admitted) : null },
    left: {
      label: "students who left this term",
      value: m ? String(m.left.withdrawn + m.left.transferred + m.left.graduated) : null,
    },
    retention: { label: "retention from last term", value: pct(m?.retention?.rate) },
    attendance: { label: "attendance rate", value: pct(summary.results?.attendanceRate) },
    average_result: {
      label: "average of published report cards (out of 100)",
      value:
        summary.results?.averageScore === null || summary.results?.averageScore === undefined
          ? null
          : summary.results.averageScore.toFixed(1),
    },
  };
  const figures = Object.fromEntries(
    Object.entries(all)
      .filter(([, v]) => v.value !== null)
      .map(([k, v]) => [k, v.value!]),
  );
  return { summary, all, figures };
}

/**
 * Prose for the board around the Command Center figures (DRF-03). The model sees each figure's name and value, writes
 * placeholders, and our code puts the figures in; any figure it wrote itself that does not match ours is flagged.
 */
export async function draftBoardReport(
  database: Database,
  ctx: TenantContext,
  input: { termId: string; campusId?: string | null },
  ai: DraftAi = null,
): Promise<BoardReportDraft> {
  assertAllowed(ctx, "drafting.board_report");
  const { summary, all, figures } = await boardFigures(database, ctx, input.termId, input.campusId ?? null);
  const listed = Object.entries(all)
    .filter(([k]) => figures[k])
    .map(([k, v]) => `{{${k}}}: ${v.label} = ${figures[k]}`)
    .join("\n");
  const { text, provider, model } = await write(
    database,
    ctx,
    "board_report",
    [
      `You draft the Proprietor's short report to the board of a school in ${countryName(ctx.tenant.countryCode)}, about one term.`,
      "Three to five short paragraphs of plain British English: money, students, results and attendance, then what to watch. Measured and factual; no exaggeration.",
      "Write every figure ONLY as its placeholder, exactly as listed, for example {{billed}}: never write digits, amounts or percentages yourself. Leave out any topic without a figure.",
      'Refer to the school as "the school". Reply with the report text only.',
    ].join("\n"),
    `${summary.campus ? `Campus: ${summary.campus.name}\n` : ""}Figures:\n${listed}`,
    ai,
  );
  const raw = text
    .replace(/^```\w*\n?|```$/g, "")
    .trim()
    .slice(0, 4000);
  // A figure the model wrote itself is fine if it is one of ours; otherwise it is flagged.
  // Numbers in our own labels ("out of 100") are ours too.
  const unchecked = uncheckedFigures(raw, [
    ...Object.values(figures),
    ...Object.values(all).map((a) => a.label),
  ]);
  const filled = fillFigures(raw, figures);
  const draftId = await keep(database, ctx, {
    task: "board_report",
    provider,
    model,
    sent: { term: summary.term.label, campus: summary.campus?.name ?? null, figures },
    drafts: [filled],
  });
  return { draftId, text: filled, uncheckedFigures: unchecked };
}

// ---- Outcomes (DRF-04) -------------------------------------------------------------------------------------------

/**
 * Records what became of a draft the person asked for: used as drafted, or changed. Once only; a draft already
 * decided, or another person's, is left as it is.
 */
export async function resolveDraft(
  database: Database,
  ctx: TenantContext,
  draftId: string | null | undefined,
  finalText: string,
): Promise<void> {
  if (!draftId || !z.string().uuid().safeParse(draftId).success) return;
  await withTenant(database, scope(ctx), async (tx) => {
    const [draft] = await tx
      .select({ drafts: aiDrafts.drafts })
      .from(aiDrafts)
      .where(
        and(
          eq(aiDrafts.tenantId, ctx.tenant.id),
          eq(aiDrafts.id, draftId),
          eq(aiDrafts.userId, ctx.userId),
          isNull(aiDrafts.outcome),
        ),
      );
    if (!draft) return;
    const outcome = draft.drafts.some((d) => sameText(d, finalText)) ? "used" : "changed";
    await tx.update(aiDrafts).set({ outcome, decidedAt: new Date() }).where(eq(aiDrafts.id, draftId));
  });
}

/** The person set the draft aside. */
export async function discardDraft(database: Database, ctx: TenantContext, draftId: string): Promise<void> {
  if (!z.string().uuid().safeParse(draftId).success) return;
  await withTenant(database, scope(ctx), (tx) =>
    tx
      .update(aiDrafts)
      .set({ outcome: "discarded", decidedAt: new Date() })
      .where(
        and(
          eq(aiDrafts.tenantId, ctx.tenant.id),
          eq(aiDrafts.id, draftId),
          eq(aiDrafts.userId, ctx.userId),
          isNull(aiDrafts.outcome),
        ),
      ),
  );
}
