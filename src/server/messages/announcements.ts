import "server-only";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import { recordSmsUsage, smsAllowance } from "../billing/usage";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  announcementReads,
  announcements,
  campuses,
  classes,
  enrolments,
  guardians,
  levels,
  studentGuardians,
  students,
  terms,
  users,
} from "../db/schema";
import { DomainError } from "../errors";
import { smsPaused } from "../fees/reminders";
import { enqueue } from "../notifications/outbox";
import { schoolsForPhone } from "../parents/schools";
import { readPreferences } from "../tenancy/preferences";
import type { TenantContext } from "../tenancy/service";

/**
 * School announcements (COM-06, PRT-05): to the whole school, or one level, class or campus. Families read
 * them in the parent view, where reading is recorded per number; by SMS too when the sender chooses, after
 * seeing how many SMS it takes. Announcements are never edited: a correction is a new one.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});
export const AUDIENCES = ["school", "level", "class", "campus"] as const;
export type Audience = (typeof AUDIENCES)[number];

interface Reach {
  phone: string;
  levelId: string | null;
  classId: string | null;
  campusId: string | null;
}

/**
 * Guardian numbers of active students, with each student's class, level and campus this term. Guardians the
 * school stopped using the parent view (e.g. a custody change) are left out of announcements too.
 */
async function reach(tx: Transaction, tenantId: string): Promise<Reach[]> {
  return tx
    .select({
      phone: guardians.phone,
      levelId: classes.levelId,
      classId: classes.id,
      campusId: classes.campusId,
    })
    .from(studentGuardians)
    .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
    .innerJoin(students, and(eq(students.id, studentGuardians.studentId), eq(students.status, "active")))
    .leftJoin(
      enrolments,
      and(
        eq(enrolments.studentId, students.id),
        sql`${enrolments.termId} = (select id from ${terms} where ${terms.tenantId} = ${tenantId} and ${terms.isCurrent})`,
      ),
    )
    .leftJoin(classes, eq(classes.id, enrolments.classId))
    .where(
      and(
        eq(studentGuardians.tenantId, tenantId),
        sql`${guardians.phone} is not null`,
        isNull(guardians.portalBlockedAt),
      ),
    ) as Promise<Reach[]>;
}

const matches = (r: Reach, audience: Audience, id: string | null) =>
  audience === "school" ||
  (audience === "level" && r.levelId === id) ||
  (audience === "class" && r.classId === id) ||
  (audience === "campus" && r.campusId === id);

const phonesFor = (rows: Reach[], audience: Audience, id: string | null) => [
  ...new Set(rows.filter((r) => matches(r, audience, id)).map((r) => r.phone)),
];

export interface AudienceOption {
  audience: Audience;
  id: string | null;
  label: string;
  /** Families (distinct numbers) it reaches: one SMS each. */
  families: number;
}

/** What an announcement can be sent to, with how many families each reaches (for the SMS estimate). */
export async function listAudiences(database: Database, ctx: TenantContext): Promise<AudienceOption[]> {
  assertAllowed(ctx, "communication.send");
  return withTenant(database, scope(ctx), async (tx) => {
    const rows = await reach(tx, ctx.tenant.id);
    const levelRows = await tx
      .select({ id: levels.id, name: levels.name })
      .from(levels)
      .where(and(eq(levels.tenantId, ctx.tenant.id), eq(levels.status, "active")))
      .orderBy(levels.sequence);
    const classRows = await tx
      .select({ id: classes.id, name: classes.name })
      .from(classes)
      .innerJoin(levels, eq(levels.id, classes.levelId))
      .where(and(eq(classes.tenantId, ctx.tenant.id), eq(classes.status, "active")))
      .orderBy(levels.sequence, classes.name);
    const campusRows = await tx
      .select({ id: campuses.id, name: campuses.name })
      .from(campuses)
      .where(and(eq(campuses.tenantId, ctx.tenant.id), eq(campuses.status, "active")))
      .orderBy(campuses.name);
    const option = (audience: Audience, id: string | null, label: string): AudienceOption => ({
      audience,
      id,
      label,
      families: phonesFor(rows, audience, id).length,
    });
    return [
      option("school", null, "The whole school"),
      ...(campusRows.length > 1 ? campusRows.map((c) => option("campus", c.id, `${c.name} campus`)) : []),
      ...levelRows.map((l) => option("level", l.id, l.name)),
      ...classRows.map((c) => option("class", c.id, c.name)),
    ].filter((o) => o.audience === "school" || o.families > 0);
  });
}

const postSchema = z.object({
  title: z.string().trim().min(2, "Give the announcement a title.").max(100, "Use 100 characters or fewer."),
  body: z.string().trim().min(1, "Write the announcement.").max(2000, "Use 2,000 characters or fewer."),
  audience: z.enum(AUDIENCES, { message: "Choose who it is for." }),
  audienceId: z.preprocess((v) => (v === "" || v === undefined ? null : v), z.string().uuid().nullable()),
  sms: z.boolean(),
});

export async function postAnnouncement(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<{ id: string; sms: number }> {
  assertAllowed(ctx, "communication.send");
  const data = postSchema.parse(input);
  if ((data.audience === "school") !== (data.audienceId === null))
    throw new DomainError("audience_invalid", "Choose who it is for.", "audience");
  if (data.sms && ctx.billing.state === "limited") throw smsPaused();
  return withTenant(database, scope(ctx), async (tx) => {
    if (data.audienceId) {
      const table = data.audience === "level" ? levels : data.audience === "class" ? classes : campuses;
      const [found] = await tx
        .select({ id: table.id })
        .from(table)
        .where(and(eq(table.tenantId, ctx.tenant.id), eq(table.id, data.audienceId)));
      if (!found) throw new DomainError("audience_invalid", "Choose who it is for.", "audience");
    }
    const phones = data.sms ? phonesFor(await reach(tx, ctx.tenant.id), data.audience, data.audienceId) : [];
    if (phones.length && !ctx.tenant.isDemo) {
      const left = await smsAllowance(tx, ctx.tenant.id, ctx.tenant.timezone);
      if (left !== null && left < phones.length)
        throw new DomainError(
          "sms_limit",
          `Sending this by SMS needs ${phones.length} SMS, and your plan has ${left} left this month. Post it without SMS, or choose fewer families.`,
        );
    }
    // Demo schools post announcements but never send SMS (their numbers are made up).
    const sent = ctx.tenant.isDemo ? 0 : phones.length;
    const [row] = await tx
      .insert(announcements)
      .values({
        tenantId: ctx.tenant.id,
        title: data.title,
        body: data.body,
        audience: data.audience,
        audienceId: data.audienceId,
        smsCount: sent,
        createdByUserId: ctx.userId,
      })
      .returning({ id: announcements.id });
    if (sent)
      for (const phone of phones) {
        const outboxId = await enqueue(tx, {
          channel: "sms",
          recipient: phone,
          template: "announcement",
          payload: { schoolName: ctx.tenant.name, title: data.title },
        });
        await recordSmsUsage(tx, ctx.tenant.id, "announcement", outboxId);
      }
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "announcement.posted",
      entityType: "announcement",
      entityId: row!.id,
      metadata: { title: data.title, audience: data.audience, audienceId: data.audienceId, sms: sent },
    });
    return { id: row!.id, sms: sent };
  });
}

export interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  audienceLabel: string;
  smsCount: number;
  by: string;
  createdAt: Date;
  /** Parent numbers that have opened it in the parent view. */
  reads: number;
}

export async function listAnnouncements(database: Database, ctx: TenantContext): Promise<AnnouncementRow[]> {
  assertAllowed(ctx, "communication.send");
  return withTenant(database, scope(ctx), async (tx) => {
    const rows = await tx
      .select({
        id: announcements.id,
        title: announcements.title,
        body: announcements.body,
        audience: announcements.audience,
        audienceId: announcements.audienceId,
        smsCount: announcements.smsCount,
        by: users.name,
        createdAt: announcements.createdAt,
        reads: sql<number>`(select count(*)::int from ${announcementReads} ar where ar.announcement_id = ${announcements.id})`,
      })
      .from(announcements)
      .innerJoin(users, eq(users.id, announcements.createdByUserId))
      .where(eq(announcements.tenantId, ctx.tenant.id))
      .orderBy(desc(announcements.createdAt))
      .limit(50);
    const names = new Map<string, string>();
    for (const t of [levels, classes, campuses] as const) {
      const ids = rows.filter((r) => r.audienceId).map((r) => r.audienceId!);
      if (!ids.length) break;
      for (const n of await tx
        .select({ id: t.id, name: t.name })
        .from(t)
        .where(and(eq(t.tenantId, ctx.tenant.id), inArray(t.id, ids))))
        names.set(n.id, t === campuses ? `${n.name} campus` : n.name);
    }
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      audienceLabel: r.audience === "school" ? "The whole school" : (names.get(r.audienceId!) ?? "A group"),
      smsCount: r.smsCount,
      by: r.by,
      createdAt: r.createdAt,
      reads: r.reads,
    }));
  });
}

// ——— The parent view ———

export interface ParentAnnouncement {
  id: string;
  title: string;
  body: string;
  createdAt: Date;
  read: boolean;
}

/** Announcements are shown for this long. */
const SHOWN_DAYS = 120;

/** Announcements reaching this number's children at one school, inside its tenant transaction. */
async function readForParent(
  tx: Transaction,
  tenantId: string,
  phone: string,
): Promise<ParentAnnouncement[]> {
  const mine = (await reach(tx, tenantId)).filter((r) => r.phone === phone);
  if (mine.length === 0) return [];
  const ids = (key: "levelId" | "classId" | "campusId") => [
    ...new Set(mine.map((r) => r[key]).filter((v): v is string => v !== null)),
  ];
  const [levelIds, classIds, campusIds] = [ids("levelId"), ids("classId"), ids("campusId")];
  const rows = await tx
    .select({
      id: announcements.id,
      title: announcements.title,
      body: announcements.body,
      createdAt: announcements.createdAt,
      read: sql<boolean>`exists (select 1 from ${announcementReads} ar where ar.announcement_id = announcements.id and ar.phone = ${phone})`,
    })
    .from(announcements)
    .where(
      and(
        eq(announcements.tenantId, tenantId),
        gt(announcements.createdAt, sql`now() - make_interval(days => ${SHOWN_DAYS})`),
        or(
          eq(announcements.audience, "school"),
          levelIds.length
            ? and(eq(announcements.audience, "level"), inArray(announcements.audienceId, levelIds))
            : undefined,
          classIds.length
            ? and(eq(announcements.audience, "class"), inArray(announcements.audienceId, classIds))
            : undefined,
          campusIds.length
            ? and(eq(announcements.audience, "campus"), inArray(announcements.audienceId, campusIds))
            : undefined,
        ),
      ),
    )
    .orderBy(desc(announcements.createdAt))
    .limit(30);
  return rows;
}

export interface ParentSchoolNews {
  slug: string;
  name: string;
  announcements: ParentAnnouncement[];
  unread: number;
}

/** For the family home: each school's recent announcements and how many are unread. */
export async function listParentAnnouncements(
  database: Database,
  phone: string,
): Promise<ParentSchoolNews[]> {
  const schools = await schoolsForPhone(database, phone);
  const result: ParentSchoolNews[] = [];
  for (const school of schools) {
    const list = await withTenant(database, { tenantId: school.id, userId: "" }, (tx) =>
      readForParent(tx, school.id, phone),
    );
    if (list.length)
      result.push({
        slug: school.slug,
        name: school.name,
        announcements: list,
        unread: list.filter((a) => !a.read).length,
      });
  }
  return result;
}

export interface SchoolContacts {
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  officeHours: string | null;
}

/** How families reach the school (PRT-06), from its preferences; null when it has given none. */
export async function readSchoolContacts(tx: Transaction, tenantId: string): Promise<SchoolContacts | null> {
  const p = await readPreferences(tx, tenantId);
  const contacts = {
    phone: p.contactPhone,
    whatsapp: p.contactWhatsapp,
    email: p.contactEmail,
    officeHours: p.officeHours,
  };
  return Object.values(contacts).some(Boolean) ? contacts : null;
}

export interface ParentSchoolPage {
  name: string;
  timezone: string;
  /** Each with `read` as it was before this visit, so new ones can be marked. */
  announcements: ParentAnnouncement[];
  contacts: SchoolContacts | null;
}

/**
 * Opening a school's news in the parent view: its announcements for this number and its contact details.
 * Opening it records the announcements as read by this number. Null when the number does not reach the
 * school.
 */
export async function openParentSchoolNews(
  database: Database,
  phone: string,
  slug: string,
): Promise<ParentSchoolPage | null> {
  const school = (await schoolsForPhone(database, phone)).find((s) => s.slug === slug);
  if (!school) return null;
  return withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => {
    const list = await readForParent(tx, school.id, phone);
    const unread = list.filter((a) => !a.read);
    if (unread.length)
      await tx
        .insert(announcementReads)
        .values(unread.map((a) => ({ tenantId: school.id, announcementId: a.id, phone })))
        .onConflictDoNothing();
    return {
      name: school.name,
      timezone: school.timezone,
      announcements: list,
      contacts: await readSchoolContacts(tx, school.id),
    };
  });
}
