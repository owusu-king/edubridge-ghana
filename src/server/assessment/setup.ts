import "server-only";
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  bandProblems,
  componentProblems,
  sortBands,
  type AssessmentComponent,
  type GradeBand,
} from "../../lib/assessment";
import { STAGES, type Stage } from "../academics/classes";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  assessmentSchemes,
  assessmentScores,
  gradingScales,
  levelSubjects,
  levels,
  reportCards,
  subjects,
  terms,
} from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { loadTerm } from "./access";
import { DEFAULT_BANDS, DEFAULT_COMPONENTS, DEFAULT_SUBJECTS } from "./defaults";

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

export interface Scheme {
  components: AssessmentComponent[];
  showPositions: boolean;
  /** False while the term still follows the previous term's scheme or the defaults (nothing saved yet). */
  saved: boolean;
}

/**
 * The term's scheme: its own once saved (by the school or by the first score), otherwise the latest earlier
 * term's, otherwise the defaults.
 */
export async function readScheme(tx: Transaction, tenantId: string, termId: string): Promise<Scheme> {
  const [own] = await tx
    .select()
    .from(assessmentSchemes)
    .where(and(eq(assessmentSchemes.tenantId, tenantId), eq(assessmentSchemes.termId, termId)));
  if (own) return { components: own.components, showPositions: own.showPositions, saved: true };
  const [term] = await tx
    .select({ startsOn: terms.startsOn })
    .from(terms)
    .where(and(eq(terms.tenantId, tenantId), eq(terms.id, termId)));
  if (term) {
    const [earlier] = await tx
      .select({ components: assessmentSchemes.components, showPositions: assessmentSchemes.showPositions })
      .from(assessmentSchemes)
      .innerJoin(terms, eq(terms.id, assessmentSchemes.termId))
      .where(and(eq(assessmentSchemes.tenantId, tenantId), lt(terms.startsOn, term.startsOn)))
      .orderBy(desc(terms.startsOn))
      .limit(1);
    if (earlier) return { ...earlier, saved: false };
  }
  return { components: DEFAULT_COMPONENTS, showPositions: false, saved: false };
}

/** Fixes the term's scheme (as shown) before the first score is stored, so scores always have their parts. */
export async function ensureScheme(tx: Transaction, ctx: TenantContext, termId: string): Promise<Scheme> {
  const scheme = await readScheme(tx, ctx.tenant.id, termId);
  if (scheme.saved) return scheme;
  await tx
    .insert(assessmentSchemes)
    .values({
      tenantId: ctx.tenant.id,
      termId,
      components: scheme.components,
      showPositions: scheme.showPositions,
      updatedByUserId: ctx.userId,
    })
    .onConflictDoNothing();
  return readScheme(tx, ctx.tenant.id, termId);
}

/** Grade bands for a stage, highest first: the school's own, or the defaults. */
export async function readBands(tx: Transaction, tenantId: string, stage: Stage): Promise<GradeBand[]> {
  const [row] = await tx
    .select({ bands: gradingScales.bands })
    .from(gradingScales)
    .where(and(eq(gradingScales.tenantId, tenantId), eq(gradingScales.stage, stage)));
  return sortBands(row?.bands ?? DEFAULT_BANDS[stage]);
}

/** The subjects a level takes, in report-card order. */
export async function readLevelSubjects(
  tx: Transaction,
  tenantId: string,
  levelId: string,
): Promise<{ id: string; name: string }[]> {
  return tx
    .select({ id: subjects.id, name: subjects.name })
    .from(levelSubjects)
    .innerJoin(subjects, eq(subjects.id, levelSubjects.subjectId))
    .where(
      and(
        eq(levelSubjects.tenantId, tenantId),
        eq(levelSubjects.levelId, levelId),
        eq(subjects.status, "active"),
      ),
    )
    .orderBy(asc(levelSubjects.sequence), asc(subjects.name));
}

async function publishedInTerm(tx: Transaction, tenantId: string, termId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(reportCards)
    .where(
      and(
        eq(reportCards.tenantId, tenantId),
        eq(reportCards.termId, termId),
        eq(reportCards.status, "published"),
      ),
    );
  return row?.n ?? 0;
}

export interface AssessmentSetup {
  term: { id: string; name: string };
  scheme: Scheme & { publishedCount: number };
  levels: { id: string; name: string; stage: Stage; subjects: { id: string; name: string }[] }[];
  subjects: { id: string; name: string; levelIds: string[] }[];
  scales: { stage: Stage; bands: GradeBand[]; custom: boolean }[];
}

export async function getAssessmentSetup(
  database: Database,
  ctx: TenantContext,
  termId: string,
): Promise<AssessmentSetup | null> {
  assertAllowed(ctx, "academics.manage");
  return withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTerm(tx, ctx.tenant.id, termId);
    if (!term) return null;
    const levelRows = await tx
      .select({ id: levels.id, name: levels.name, stage: levels.stage })
      .from(levels)
      .where(and(eq(levels.tenantId, ctx.tenant.id), eq(levels.status, "active")))
      .orderBy(asc(levels.sequence), asc(levels.name));
    const links = await tx
      .select({
        levelId: levelSubjects.levelId,
        subjectId: levelSubjects.subjectId,
        sequence: levelSubjects.sequence,
      })
      .from(levelSubjects)
      .where(eq(levelSubjects.tenantId, ctx.tenant.id))
      .orderBy(asc(levelSubjects.sequence));
    const subjectRows = await tx
      .select({ id: subjects.id, name: subjects.name })
      .from(subjects)
      .where(and(eq(subjects.tenantId, ctx.tenant.id), eq(subjects.status, "active")))
      .orderBy(asc(subjects.name));
    const nameOf = new Map(subjectRows.map((s) => [s.id, s.name]));
    const customScales = await tx
      .select({ stage: gradingScales.stage, bands: gradingScales.bands })
      .from(gradingScales)
      .where(eq(gradingScales.tenantId, ctx.tenant.id));
    const stagesInUse = STAGES.filter((s) => levelRows.some((l) => l.stage === s));
    return {
      term: { id: term.id, name: term.name },
      scheme: {
        ...(await readScheme(tx, ctx.tenant.id, term.id)),
        publishedCount: await publishedInTerm(tx, ctx.tenant.id, term.id),
      },
      levels: levelRows.map((l) => ({
        ...l,
        subjects: links
          .filter((link) => link.levelId === l.id && nameOf.has(link.subjectId))
          .map((link) => ({ id: link.subjectId, name: nameOf.get(link.subjectId)! })),
      })),
      subjects: subjectRows.map((s) => ({
        ...s,
        // In promotion order, like the levels themselves.
        levelIds: levelRows
          .filter((l) => links.some((link) => link.subjectId === s.id && link.levelId === l.id))
          .map((l) => l.id),
      })),
      scales: stagesInUse.map((stage) => {
        const custom = customScales.find((c) => c.stage === stage);
        return { stage, bands: sortBands(custom?.bands ?? DEFAULT_BANDS[stage]), custom: Boolean(custom) };
      }),
    };
  });
}

/** Adds the default subjects of each level's stage. Only while the school has no subjects. */
export async function setupDefaultSubjects(database: Database, ctx: TenantContext): Promise<number> {
  assertAllowed(ctx, "academics.manage");
  return withTenant(database, scope(ctx), async (tx) => {
    const [existing] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(subjects)
      .where(eq(subjects.tenantId, ctx.tenant.id));
    if ((existing?.n ?? 0) > 0)
      throw new DomainError("subjects_exist", "Subjects are already set up. Add or change subjects instead.");
    const levelRows = await tx
      .select({ id: levels.id, stage: levels.stage })
      .from(levels)
      .where(and(eq(levels.tenantId, ctx.tenant.id), eq(levels.status, "active")));
    if (levelRows.length === 0) throw new DomainError("no_levels", "Set up your levels under Classes first.");
    const names = [...new Set(levelRows.flatMap((l) => DEFAULT_SUBJECTS[l.stage]))];
    const created = await tx
      .insert(subjects)
      .values(names.map((name) => ({ tenantId: ctx.tenant.id, name })))
      .returning({ id: subjects.id, name: subjects.name });
    const idOf = new Map(created.map((s) => [s.name, s.id]));
    await tx.insert(levelSubjects).values(
      levelRows.flatMap((level) =>
        DEFAULT_SUBJECTS[level.stage].map((name, i) => ({
          tenantId: ctx.tenant.id,
          levelId: level.id,
          subjectId: idOf.get(name)!,
          sequence: (i + 1) * 10,
        })),
      ),
    );
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "subjects.set_up",
      entityType: "subject",
      metadata: { count: names.length },
    });
    return names.length;
  });
}

const subjectSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(60, "Use 60 characters or fewer."),
  levelIds: z.array(z.string().uuid()).max(100),
});

async function setSubjectLevels(
  tx: Transaction,
  ctx: TenantContext,
  subjectId: string,
  levelIds: string[],
): Promise<void> {
  const valid = levelIds.length
    ? await tx
        .select({ id: levels.id })
        .from(levels)
        .where(and(eq(levels.tenantId, ctx.tenant.id), inArray(levels.id, levelIds)))
    : [];
  if (valid.length !== new Set(levelIds).size)
    throw new DomainError("level_invalid", "Choose levels from the list.", "levelIds");
  const current = await tx
    .select({ levelId: levelSubjects.levelId })
    .from(levelSubjects)
    .where(and(eq(levelSubjects.tenantId, ctx.tenant.id), eq(levelSubjects.subjectId, subjectId)));
  const have = new Set(current.map((c) => c.levelId));
  const want = new Set(levelIds);
  const removed = [...have].filter((id) => !want.has(id));
  if (removed.length)
    await tx
      .delete(levelSubjects)
      .where(
        and(
          eq(levelSubjects.tenantId, ctx.tenant.id),
          eq(levelSubjects.subjectId, subjectId),
          inArray(levelSubjects.levelId, removed),
        ),
      );
  for (const levelId of [...want].filter((id) => !have.has(id))) {
    // New subjects go last on the level's report card.
    const [last] = await tx
      .select({ max: sql<number | null>`max(${levelSubjects.sequence})` })
      .from(levelSubjects)
      .where(and(eq(levelSubjects.tenantId, ctx.tenant.id), eq(levelSubjects.levelId, levelId)));
    await tx
      .insert(levelSubjects)
      .values({ tenantId: ctx.tenant.id, levelId, subjectId, sequence: (last?.max ?? 0) + 10 });
  }
}

function duplicateName(error: unknown): never {
  if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
    throw new DomainError("duplicate", "A subject with this name already exists.", "name");
  throw error;
}

export async function createSubject(database: Database, ctx: TenantContext, input: unknown): Promise<string> {
  assertAllowed(ctx, "academics.manage");
  const data = subjectSchema.parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    const [subject] = await tx
      .insert(subjects)
      .values({ tenantId: ctx.tenant.id, name: data.name })
      .returning({ id: subjects.id });
    await setSubjectLevels(tx, ctx, subject!.id, data.levelIds);
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "subject.created",
      entityType: "subject",
      entityId: subject!.id,
      metadata: { name: data.name, levels: data.levelIds.length },
    });
    return subject!.id;
  }).catch(duplicateName);
}

/**
 * Renames a subject and sets the levels that take it. Taking a subject off a level keeps its scores; it just
 * no longer shows on that level's score sheets and draft report cards (published ones are frozen).
 */
export async function updateSubject(
  database: Database,
  ctx: TenantContext,
  subjectId: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "academics.manage");
  const data = subjectSchema.parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    if (!z.string().uuid().safeParse(subjectId).success)
      throw new DomainError("subject_not_found", "Subject not found.");
    const [subject] = await tx
      .select()
      .from(subjects)
      .where(and(eq(subjects.tenantId, ctx.tenant.id), eq(subjects.id, subjectId)))
      .for("update");
    if (!subject) throw new DomainError("subject_not_found", "Subject not found.");
    await tx
      .update(subjects)
      .set({ name: data.name, updatedAt: new Date() })
      .where(eq(subjects.id, subject.id));
    await setSubjectLevels(tx, ctx, subject.id, data.levelIds);
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "subject.updated",
      entityType: "subject",
      entityId: subject.id,
      metadata: { changes: { name: { from: subject.name, to: data.name } }, levels: data.levelIds.length },
    });
  }).catch(duplicateName);
}

const componentInput = z.object({
  key: z
    .string()
    .regex(/^[a-z0-9_]{1,20}$/)
    .optional(),
  name: z.string().trim().min(1, "Give every part a name.").max(30, "Use 30 characters or fewer."),
  weight: z.coerce.number(),
  outOf: z.coerce.number(),
});

/**
 * Changes how a term is assessed. Parts keep their keys, so renaming or reweighting a part keeps its scores
 * (totals are recalculated). A part with scores cannot be removed, and nothing changes once a report card of
 * the term is published (withdraw them first), so published reports and live results always agree.
 */
export async function saveAssessmentScheme(
  database: Database,
  ctx: TenantContext,
  termId: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "academics.manage");
  const data = z
    .object({ components: z.array(componentInput).max(10), showPositions: z.boolean() })
    .parse(input);
  const components: AssessmentComponent[] = data.components.map((c) => ({
    key: c.key ?? `p${randomBytes(4).toString("hex")}`,
    name: c.name,
    weight: c.weight,
    outOf: c.outOf,
  }));
  const problems = componentProblems(components);
  if (problems.length) throw new DomainError("scheme_invalid", problems[0]!, "components");
  await withTenant(database, scope(ctx), async (tx) => {
    const term = await loadTerm(tx, ctx.tenant.id, termId);
    if (!term) throw new DomainError("term_not_found", "Term not found.");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`scheme:${term.id}`}))`);
    if ((await publishedInTerm(tx, ctx.tenant.id, term.id)) > 0)
      throw new DomainError(
        "scheme_locked",
        "Report cards for this term are published. Withdraw them before changing how the term is assessed.",
      );
    const before = await readScheme(tx, ctx.tenant.id, term.id);
    const keep = new Set(components.map((c) => c.key));
    const removed = before.components.filter((c) => !keep.has(c.key));
    if (removed.length) {
      const [scored] = await tx
        .select({ key: assessmentScores.componentKey })
        .from(assessmentScores)
        .where(
          and(
            eq(assessmentScores.tenantId, ctx.tenant.id),
            eq(assessmentScores.termId, term.id),
            inArray(
              assessmentScores.componentKey,
              removed.map((c) => c.key),
            ),
          ),
        )
        .limit(1);
      if (scored) {
        const name = removed.find((c) => c.key === scored.key)?.name ?? "A part";
        throw new DomainError(
          "component_scored",
          `${name} already has scores this term, so it cannot be removed. Clear its scores first.`,
          "components",
        );
      }
    }
    // A lower "out of" must still hold every score already entered for the part.
    for (const c of components) {
      const [max] = await tx
        .select({ max: sql<number | null>`max(${assessmentScores.scoreTenths})` })
        .from(assessmentScores)
        .where(
          and(
            eq(assessmentScores.tenantId, ctx.tenant.id),
            eq(assessmentScores.termId, term.id),
            eq(assessmentScores.componentKey, c.key),
          ),
        );
      if (max?.max !== null && max?.max !== undefined && max.max > c.outOf * 10)
        throw new DomainError(
          "out_of_too_low",
          `Some ${c.name} scores are above ${c.outOf}. Correct them first, or mark it out of more.`,
          "components",
        );
    }
    await tx
      .insert(assessmentSchemes)
      .values({
        tenantId: ctx.tenant.id,
        termId: term.id,
        components,
        showPositions: data.showPositions,
        updatedByUserId: ctx.userId,
      })
      .onConflictDoUpdate({
        target: [assessmentSchemes.tenantId, assessmentSchemes.termId],
        set: {
          components,
          showPositions: data.showPositions,
          updatedByUserId: ctx.userId,
          updatedAt: new Date(),
        },
      });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "assessment_scheme.saved",
      entityType: "term",
      entityId: term.id,
      metadata: {
        term: term.name,
        from: before.components.map((c) => `${c.name} ${c.weight}%`),
        to: components.map((c) => `${c.name} ${c.weight}%`),
        showPositions: data.showPositions,
      },
    });
  });
}

const bandInput = z.object({
  min: z.coerce.number(),
  grade: z
    .string()
    .trim()
    .min(1, "Give every band a grade.")
    .max(4, "Use 4 characters or fewer for a grade."),
  remark: z.string().trim().max(40, "Use 40 characters or fewer for a remark."),
});

/** Sets a stage's grade bands. Published report cards keep the bands they were published with. */
export async function saveGradingScale(
  database: Database,
  ctx: TenantContext,
  stage: Stage,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "academics.manage");
  const parsedStage = z.enum(STAGES).parse(stage);
  const { bands } = z.object({ bands: z.array(bandInput).max(20) }).parse(input);
  const problems = bandProblems(bands);
  if (problems.length) throw new DomainError("bands_invalid", problems[0]!, "bands");
  const sorted = sortBands(bands);
  await withTenant(database, scope(ctx), async (tx) => {
    const before = await readBands(tx, ctx.tenant.id, parsedStage);
    await tx
      .insert(gradingScales)
      .values({ tenantId: ctx.tenant.id, stage: parsedStage, bands: sorted, updatedByUserId: ctx.userId })
      .onConflictDoUpdate({
        target: [gradingScales.tenantId, gradingScales.stage],
        set: { bands: sorted, updatedByUserId: ctx.userId, updatedAt: new Date() },
      });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "grading_scale.saved",
      entityType: "grading_scale",
      entityId: parsedStage,
      metadata: {
        from: before.map((b) => `${b.grade} ${b.min}+`),
        to: sorted.map((b) => `${b.grade} ${b.min}+`),
      },
    });
  });
}

/** Goes back to the stage's default bands. */
export async function resetGradingScale(database: Database, ctx: TenantContext, stage: Stage): Promise<void> {
  assertAllowed(ctx, "academics.manage");
  const parsedStage = z.enum(STAGES).parse(stage);
  await withTenant(database, scope(ctx), async (tx) => {
    const removed = await tx
      .delete(gradingScales)
      .where(and(eq(gradingScales.tenantId, ctx.tenant.id), eq(gradingScales.stage, parsedStage)))
      .returning({ id: gradingScales.id });
    if (!removed.length) return;
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "grading_scale.reset",
      entityType: "grading_scale",
      entityId: parsedStage,
    });
  });
}
