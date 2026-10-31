import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertCan } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { campuses, classes, levels, memberships, users } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import { canAccessCampus, type TenantContext } from "../tenancy/service";

export const STAGES = ["creche", "nursery", "kindergarten", "primary", "jhs"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  creche: "Creche",
  nursery: "Nursery",
  kindergarten: "Kindergarten",
  primary: "Primary",
  jhs: "Junior High School",
};

/**
 * Default Ghanaian basic-school levels. Assumption to verify: GES naming of KG 1–2, Basic 1–6 (formerly
 * Primary/Class 1–6) and JHS 1–3. Schools can rename, add and archive levels.
 */
export const DEFAULT_LEVELS: Record<Stage, string[]> = {
  creche: ["Creche"],
  nursery: ["Nursery 1", "Nursery 2"],
  kindergarten: ["KG 1", "KG 2"],
  primary: ["Basic 1", "Basic 2", "Basic 3", "Basic 4", "Basic 5", "Basic 6"],
  jhs: ["JHS 1", "JHS 2", "JHS 3"],
};

const STAFF_ROLES = ["owner", "headteacher", "admin", "bursar", "teacher"];

export interface ClassSummary {
  id: string;
  name: string;
  campusId: string;
  campusName: string;
  status: "active" | "archived";
  classTeacher: { membershipId: string; name: string } | null;
}

export interface LevelWithClasses {
  id: string;
  name: string;
  stage: Stage;
  classes: ClassSummary[];
}

const scope = (ctx: TenantContext) => ({ tenantId: ctx.tenant.id, userId: ctx.userId });
const nameSchema = z.string().trim().min(1, "Enter a name.").max(40, "Use 40 characters or fewer.");
const uuidOrEmpty = z.union([z.string().uuid(), z.literal(""), z.null()]).transform((v) => (v ? v : null));

export const classInputSchema = z.object({
  levelId: z.string().uuid("Choose a level."),
  campusId: z.string().uuid("Choose a campus."),
  name: nameSchema,
  classTeacherMembershipId: uuidOrEmpty.optional().transform((v) => v ?? null),
});

function mapUnique(message: string, field: string) {
  return (error: unknown): never => {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw new DomainError("duplicate", message, field);
    throw error;
  };
}

export async function listLevelsWithClasses(
  database: Database,
  ctx: TenantContext,
): Promise<LevelWithClasses[]> {
  assertCan(ctx.roles, "classes.view");
  return withTenant(database, scope(ctx), async (tx) => {
    const levelRows = await tx
      .select()
      .from(levels)
      .where(and(eq(levels.tenantId, ctx.tenant.id), eq(levels.status, "active")))
      .orderBy(asc(levels.sequence), asc(levels.name));
    const classRows = await tx
      .select({
        id: classes.id,
        levelId: classes.levelId,
        name: classes.name,
        campusId: classes.campusId,
        campusName: campuses.name,
        status: classes.status,
        teacherMembershipId: classes.classTeacherMembershipId,
        teacherName: users.name,
      })
      .from(classes)
      .innerJoin(campuses, eq(campuses.id, classes.campusId))
      .leftJoin(memberships, eq(memberships.id, classes.classTeacherMembershipId))
      .leftJoin(users, eq(users.id, memberships.userId))
      .where(eq(classes.tenantId, ctx.tenant.id))
      .orderBy(asc(classes.name));
    return levelRows.map((level) => ({
      id: level.id,
      name: level.name,
      stage: level.stage,
      classes: classRows
        .filter((c) => c.levelId === level.id && canAccessCampus(ctx, c.campusId))
        .map((c) => ({
          id: c.id,
          name: c.name,
          campusId: c.campusId,
          campusName: c.campusName,
          status: c.status,
          classTeacher:
            c.teacherMembershipId && c.teacherName
              ? { membershipId: c.teacherMembershipId, name: c.teacherName }
              : null,
        })),
    }));
  });
}

/** Creates the default levels for the stages a school runs. Only allowed while the school has no levels. */
export async function setupDefaultLevels(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<number> {
  assertCan(ctx.roles, "academics.manage");
  const { stages } = z
    .object({ stages: z.array(z.enum(STAGES)).min(1, "Choose at least one stage.") })
    .parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    const [existing] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(levels)
      .where(eq(levels.tenantId, ctx.tenant.id));
    if ((existing?.n ?? 0) > 0)
      throw new DomainError("levels_exist", "Levels are already set up. Add or rename levels instead.");
    const rows = STAGES.filter((s) => stages.includes(s)).flatMap((stage) =>
      DEFAULT_LEVELS[stage].map((name) => ({ stage, name })),
    );
    await tx.insert(levels).values(
      rows.map((r, i) => ({
        tenantId: ctx.tenant.id,
        name: r.name,
        stage: r.stage,
        sequence: (i + 1) * 10,
      })),
    );
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "levels.set_up",
      entityType: "level",
      metadata: { stages, count: rows.length },
    });
    return rows.length;
  });
}

export async function createLevel(database: Database, ctx: TenantContext, input: unknown): Promise<string> {
  assertCan(ctx.roles, "academics.manage");
  const data = z
    .object({ name: nameSchema, stage: z.enum(STAGES, { message: "Choose a stage." }) })
    .parse(input);
  return withTenant(database, scope(ctx), async (tx) => {
    // New levels go after the last level of the same stage (or of earlier stages).
    const order = STAGES.indexOf(data.stage);
    const [after] = await tx
      .select({ max: sql<number | null>`max(${levels.sequence})` })
      .from(levels)
      .where(
        and(
          eq(levels.tenantId, ctx.tenant.id),
          sql`array_position(${sql.raw(`ARRAY['${STAGES.join("','")}']`)}::text[], ${levels.stage}) <= ${order + 1}`,
        ),
      );
    const [level] = await tx
      .insert(levels)
      .values({
        tenantId: ctx.tenant.id,
        name: data.name,
        stage: data.stage,
        sequence: (after?.max ?? 0) + 5,
      })
      .returning({ id: levels.id });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "level.created",
      entityType: "level",
      entityId: level!.id,
      metadata: { name: data.name },
    });
    return level!.id;
  }).catch(mapUnique("A level with this name already exists.", "name"));
}

export async function renameLevel(
  database: Database,
  ctx: TenantContext,
  levelId: string,
  input: unknown,
): Promise<void> {
  assertCan(ctx.roles, "academics.manage");
  const { name } = z.object({ name: nameSchema }).parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    const [level] = await tx
      .select()
      .from(levels)
      .where(and(eq(levels.tenantId, ctx.tenant.id), eq(levels.id, levelId)));
    if (!level) throw new DomainError("level_not_found", "Level not found.");
    await tx.update(levels).set({ name, updatedAt: new Date() }).where(eq(levels.id, level.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "level.renamed",
      entityType: "level",
      entityId: level.id,
      metadata: { changes: { name: { from: level.name, to: name } } },
    });
  }).catch(mapUnique("A level with this name already exists.", "name"));
}

export interface TeacherOption {
  membershipId: string;
  name: string;
}

/** Active staff who can be class teachers. */
export async function listTeacherOptions(database: Database, ctx: TenantContext): Promise<TeacherOption[]> {
  assertCan(ctx.roles, "classes.view");
  return withTenant(database, scope(ctx), (tx) =>
    tx
      .select({ membershipId: memberships.id, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.tenantId, ctx.tenant.id),
          eq(memberships.status, "active"),
          sql`${memberships.roles} && ${sql.raw(`ARRAY['${STAFF_ROLES.join("','")}']`)}::text[]`,
        ),
      )
      .orderBy(asc(users.name)),
  );
}

async function assertValidTeacher(
  tx: Transaction,
  tenantId: string,
  membershipId: string | null,
): Promise<void> {
  if (!membershipId) return;
  const [row] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.id, membershipId),
        eq(memberships.status, "active"),
        sql`${memberships.roles} && ${sql.raw(`ARRAY['${STAFF_ROLES.join("','")}']`)}::text[]`,
      ),
    );
  if (!row)
    throw new DomainError(
      "teacher_invalid",
      "Choose an active staff member as class teacher.",
      "classTeacherMembershipId",
    );
}

function assertCampus(ctx: TenantContext, campusId: string): void {
  if (!canAccessCampus(ctx, campusId))
    throw new DomainError("campus_scope", "You can only manage classes at your campuses.", "campusId");
}

export async function createClass(database: Database, ctx: TenantContext, input: unknown): Promise<string> {
  assertCan(ctx.roles, "academics.manage");
  const data = classInputSchema.parse(input);
  assertCampus(ctx, data.campusId);
  return withTenant(database, scope(ctx), async (tx) => {
    await assertValidTeacher(tx, ctx.tenant.id, data.classTeacherMembershipId);
    const [level] = await tx
      .select({ id: levels.id })
      .from(levels)
      .where(
        and(eq(levels.tenantId, ctx.tenant.id), eq(levels.id, data.levelId), eq(levels.status, "active")),
      );
    if (!level) throw new DomainError("level_invalid", "Choose a level.", "levelId");
    const [campus] = await tx
      .select({ id: campuses.id })
      .from(campuses)
      .where(
        and(
          eq(campuses.tenantId, ctx.tenant.id),
          eq(campuses.id, data.campusId),
          eq(campuses.status, "active"),
        ),
      );
    if (!campus) throw new DomainError("campus_invalid", "Choose an active campus.", "campusId");
    const [created] = await tx
      .insert(classes)
      .values({
        tenantId: ctx.tenant.id,
        levelId: data.levelId,
        campusId: data.campusId,
        name: data.name,
        classTeacherMembershipId: data.classTeacherMembershipId,
      })
      .returning({ id: classes.id });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "class.created",
      entityType: "class",
      entityId: created!.id,
      metadata: { name: data.name },
    });
    return created!.id;
  }).catch(mapUnique("A class with this name already exists at this campus.", "name"));
}

export async function updateClass(
  database: Database,
  ctx: TenantContext,
  classId: string,
  input: unknown,
): Promise<void> {
  assertCan(ctx.roles, "academics.manage");
  const data = z
    .object({
      name: nameSchema,
      classTeacherMembershipId: uuidOrEmpty.optional().transform((v) => v ?? null),
    })
    .parse(input);
  await withTenant(database, scope(ctx), async (tx) => {
    if (!z.string().uuid().safeParse(classId).success)
      throw new DomainError("class_not_found", "Class not found.");
    const [cls] = await tx
      .select()
      .from(classes)
      .where(and(eq(classes.tenantId, ctx.tenant.id), eq(classes.id, classId)))
      .for("update");
    if (!cls) throw new DomainError("class_not_found", "Class not found.");
    assertCampus(ctx, cls.campusId);
    await assertValidTeacher(tx, ctx.tenant.id, data.classTeacherMembershipId);
    await tx
      .update(classes)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(classes.id, cls.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "class.updated",
      entityType: "class",
      entityId: cls.id,
      metadata: {
        changes: {
          name: { from: cls.name, to: data.name },
          classTeacher: { from: cls.classTeacherMembershipId, to: data.classTeacherMembershipId },
        },
      },
    });
  }).catch(mapUnique("A class with this name already exists at this campus.", "name"));
}

export async function setClassStatus(
  database: Database,
  ctx: TenantContext,
  classId: string,
  status: "active" | "archived",
): Promise<void> {
  assertCan(ctx.roles, "academics.manage");
  await withTenant(database, scope(ctx), async (tx) => {
    if (!z.string().uuid().safeParse(classId).success)
      throw new DomainError("class_not_found", "Class not found.");
    const [cls] = await tx
      .select()
      .from(classes)
      .where(and(eq(classes.tenantId, ctx.tenant.id), eq(classes.id, classId)))
      .for("update");
    if (!cls) throw new DomainError("class_not_found", "Class not found.");
    assertCampus(ctx, cls.campusId);
    if (cls.status === status) return;
    await tx.update(classes).set({ status, updatedAt: new Date() }).where(eq(classes.id, cls.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: status === "archived" ? "class.archived" : "class.restored",
      entityType: "class",
      entityId: cls.id,
      metadata: { name: cls.name },
    });
  });
}
