import "server-only";
import { and, desc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertAllowed, can, isRole } from "../authz/permissions";
import { recordSmsUsage, smsAllowance } from "../billing/usage";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  announcementReads,
  announcements,
  campuses,
  classes,
  levels,
  memberships,
  scheduledAnnouncements,
  tenants,
  users,
} from "../db/schema";
import { readBillingState } from "../billing/state";
import { localToUtc } from "@/lib/format";
import { DomainError } from "../errors";
import { smsPaused } from "../fees/reminders";
import { enqueue, smsSegmentsFor } from "../notifications/outbox";
import { pushSubscriptionsFor } from "../parents/push";
import { schoolsForPhone } from "../parents/schools";
import { readPreferences } from "../tenancy/preferences";
import {
  assertAudience,
  audienceFields,
  audienceKeys,
  audienceLabels,
  familyReach as reach,
  phonesFor,
  type Audience,
} from "./audience";
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
export { AUDIENCES, type Audience } from "./audience";

export interface AudienceOption {
  audience: Audience;
  id: string | null;
  label: string;
  /** Families (distinct numbers) it reaches. */
  families: number;
  /** Of those, families with notifications on (they get a free push instead of an SMS). */
  withPush: number;
}

/** What an announcement can be sent to, with how many families each reaches (for the SMS estimate). */
export async function listAudiences(database: Database, ctx: TenantContext): Promise<AudienceOption[]> {
  assertAllowed(ctx, "communication.send");
  return withTenant(database, scope(ctx), async (tx) => {
    const rows = await reach(tx, ctx.tenant.id);
    const pushed = new Set(
      (await pushSubscriptionsFor(tx, [...new Set(rows.map((r) => r.phone))])).map((d) => d.phone),
    );
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
    const option = (audience: Audience, id: string | null, label: string): AudienceOption => {
      const phones = phonesFor(rows, audience, id);
      return {
        audience,
        id,
        label,
        families: phones.length,
        withPush: phones.filter((p) => pushed.has(p)).length,
      };
    };
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
  ...audienceFields,
  sms: z.boolean(),
  /** NOT-06: school-local "2026-11-20T07:30" to post it then; empty or absent: now. */
  sendAt: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Choose a day and time.")
      .optional(),
  ),
});

type PostData = z.infer<typeof postSchema>;

interface School {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  isDemo: boolean;
}

/**
 * Posts an announcement in the school's tenant transaction: the announcement, a free push to families with
 * notifications on, and (when chosen) SMS to the others within the allowance. `onLimit: "skip"` (scheduled
 * posts) posts without SMS instead of refusing when SMS are paused or the allowance is short.
 */
async function publishInTx(
  tx: Transaction,
  school: School,
  userId: string,
  data: Omit<PostData, "sendAt">,
  opts: { smsPaused: boolean; onLimit: "throw" | "skip" },
): Promise<{ id: string; sms: number; push: number; smsSkipped: string | null }> {
  await assertAudience(tx, school.id, data.audience, data.audienceId);
  // Families with notifications on get a free push (PSH-03); SMS, when chosen, go only to the others.
  const families = school.isDemo ? [] : phonesFor(await reach(tx, school.id), data.audience, data.audienceId);
  const devices = await pushSubscriptionsFor(tx, families);
  const pushed = new Set(devices.map((d) => d.phone));
  let phones = data.sms ? families.filter((p) => !pushed.has(p)) : [];
  let smsSkipped: string | null = null;
  if (phones.length && opts.smsPaused) {
    if (opts.onLimit === "throw") throw smsPaused();
    phones = [];
    smsSkipped = "SMS were paused for an overdue EduBridge invoice.";
  }
  if (phones.length) {
    const left = await smsAllowance(tx, school.id, school.timezone);
    const need =
      phones.length * smsSegmentsFor("announcement", { schoolName: school.name, title: data.title });
    if (left !== null && left < need) {
      if (opts.onLimit === "throw")
        throw new DomainError(
          "sms_limit",
          `Sending this by SMS needs ${need} SMS, and your plan has ${left} left this month. Post it without SMS, shorten the title, or choose fewer families.`,
        );
      phones = [];
      smsSkipped = `It needed ${need} SMS and the plan had ${left} left, so it went without SMS.`;
    }
  }
  // Demo schools post announcements but never send SMS or push (their numbers are made up).
  const sent = phones.length;
  const [row] = await tx
    .insert(announcements)
    .values({
      tenantId: school.id,
      title: data.title,
      body: data.body,
      audience: data.audience,
      audienceId: data.audienceId,
      smsCount: sent,
      pushCount: pushed.size,
      createdByUserId: userId,
    })
    .returning({ id: announcements.id });
  for (const phone of phones) {
    const outboxId = await enqueue(tx, {
      channel: "sms",
      recipient: phone,
      template: "announcement",
      payload: { schoolName: school.name, title: data.title },
    });
    await recordSmsUsage(tx, school.id, "announcement", outboxId);
  }
  for (const device of devices)
    await enqueue(tx, {
      channel: "push",
      recipient: device.id,
      template: "announcement_push",
      payload: { schoolName: school.name, schoolSlug: school.slug },
    });
  await recordAudit(tx, {
    tenantId: school.id,
    actorUserId: userId,
    action: "announcement.posted",
    entityType: "announcement",
    entityId: row!.id,
    metadata: {
      title: data.title,
      audience: data.audience,
      audienceId: data.audienceId,
      sms: sent,
      push: pushed.size,
      ...(smsSkipped ? { smsSkipped } : {}),
    },
  });
  return { id: row!.id, sms: sent, push: pushed.size, smsSkipped };
}

/** How far ahead an announcement can be scheduled. */
const SCHEDULE_MAX_DAYS = 60;

/**
 * Posts an announcement now, or schedules it (NOT-06) for a school-local day and time: nothing is sent or
 * charged until then, and it can be cancelled until it is posted.
 */
export async function postAnnouncement(
  database: Database,
  ctx: TenantContext,
  input: unknown,
  now = new Date(),
): Promise<{ id: string; sms: number; push: number; scheduledFor?: Date }> {
  assertAllowed(ctx, "communication.send");
  const { sendAt, ...data } = postSchema.parse(input);
  if (sendAt) {
    const at = localToUtc(sendAt, ctx.tenant.timezone);
    if (at.getTime() < now.getTime() + 5 * 60_000)
      throw new DomainError("schedule_past", "Choose a time at least five minutes from now.", "sendAt");
    if (at.getTime() > now.getTime() + SCHEDULE_MAX_DAYS * 86_400_000)
      throw new DomainError("schedule_far", "Choose a time within 60 days.", "sendAt");
    return withTenant(database, scope(ctx), async (tx) => {
      await assertAudience(tx, ctx.tenant.id, data.audience, data.audienceId);
      const [row] = await tx
        .insert(scheduledAnnouncements)
        .values({ tenantId: ctx.tenant.id, ...data, sendAt: at, createdByUserId: ctx.userId })
        .returning({ id: scheduledAnnouncements.id });
      await recordAudit(tx, {
        tenantId: ctx.tenant.id,
        actorUserId: ctx.userId,
        action: "announcement.scheduled",
        entityType: "scheduled_announcement",
        entityId: row!.id,
        metadata: { title: data.title, sendAt: at.toISOString(), sms: data.sms },
      });
      return { id: row!.id, sms: 0, push: 0, scheduledFor: at };
    });
  }
  const posted = await withTenant(database, scope(ctx), (tx) =>
    publishInTx(tx, ctx.tenant, ctx.userId, data, {
      smsPaused: ctx.billing.state === "limited",
      onLimit: "throw",
    }),
  );
  return { id: posted.id, sms: posted.sms, push: posted.push };
}

export interface ScheduledAnnouncementRow {
  id: string;
  title: string;
  audienceLabel: string;
  sms: boolean;
  sendAt: Date;
  by: string;
}

/** Announcements waiting to be posted, soonest first. */
export async function listScheduledAnnouncements(
  database: Database,
  ctx: TenantContext,
): Promise<ScheduledAnnouncementRow[]> {
  assertAllowed(ctx, "communication.send");
  return withTenant(database, scope(ctx), async (tx) => {
    const rows = await tx
      .select({ s: scheduledAnnouncements, by: users.name })
      .from(scheduledAnnouncements)
      .innerJoin(users, eq(users.id, scheduledAnnouncements.createdByUserId))
      .where(
        and(eq(scheduledAnnouncements.tenantId, ctx.tenant.id), eq(scheduledAnnouncements.status, "pending")),
      )
      .orderBy(scheduledAnnouncements.sendAt);
    const label = await audienceLabels(
      tx,
      ctx.tenant.id,
      rows.map((r) => r.s),
    );
    return rows.map(({ s, by }) => ({
      id: s.id,
      title: s.title,
      audienceLabel: label(s),
      sms: s.sms,
      sendAt: s.sendAt,
      by,
    }));
  });
}

export async function cancelScheduledAnnouncement(
  database: Database,
  ctx: TenantContext,
  id: string,
): Promise<void> {
  assertAllowed(ctx, "communication.send");
  if (!z.string().uuid().safeParse(id).success) throw new DomainError("not_found", "Announcement not found.");
  await withTenant(database, scope(ctx), async (tx) => {
    const done = await tx
      .update(scheduledAnnouncements)
      .set({ status: "cancelled", cancelledByUserId: ctx.userId, updatedAt: new Date() })
      .where(
        and(
          eq(scheduledAnnouncements.tenantId, ctx.tenant.id),
          eq(scheduledAnnouncements.id, id),
          eq(scheduledAnnouncements.status, "pending"),
        ),
      )
      .returning({ title: scheduledAnnouncements.title });
    if (!done.length)
      throw new DomainError("not_found", "This announcement was already posted or cancelled.");
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "announcement.schedule_cancelled",
      entityType: "scheduled_announcement",
      entityId: id,
      metadata: { title: done[0]!.title },
    });
  });
}

/**
 * Posts the announcements whose time has come (worker). The author must still be an active member allowed
 * to send announcements, or it is cancelled with a note. SMS that cannot go (paused, or over the allowance)
 * are skipped and the announcement is posted with its push.
 */
export async function runScheduledAnnouncements(
  database: Database,
  now = new Date(),
): Promise<{ posted: number; cancelled: number }> {
  const schools = await database
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      timezone: tenants.timezone,
      isDemo: tenants.isDemo,
    })
    .from(tenants)
    .where(eq(tenants.status, "active"));
  const total = { posted: 0, cancelled: 0 };
  for (const school of schools) {
    await withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => {
      const due = await tx
        .select()
        .from(scheduledAnnouncements)
        .where(
          and(
            eq(scheduledAnnouncements.tenantId, school.id),
            eq(scheduledAnnouncements.status, "pending"),
            lte(scheduledAnnouncements.sendAt, now),
          ),
        )
        .for("update", { skipLocked: true });
      if (!due.length) return;
      const paused = (await readBillingState(tx, school)).state === "limited";
      for (const item of due) {
        const [author] = await tx
          .select({ roles: memberships.roles })
          .from(memberships)
          .where(
            and(
              eq(memberships.tenantId, school.id),
              eq(memberships.userId, item.createdByUserId),
              eq(memberships.status, "active"),
            ),
          );
        const roles = (author?.roles ?? []).filter(isRole);
        if (!can(roles, "communication.send")) {
          await tx
            .update(scheduledAnnouncements)
            .set({
              status: "cancelled",
              note: "Its author can no longer send announcements.",
              updatedAt: now,
            })
            .where(eq(scheduledAnnouncements.id, item.id));
          total.cancelled++;
          continue;
        }
        const posted = await publishInTx(
          tx,
          school,
          item.createdByUserId,
          {
            title: item.title,
            body: item.body,
            audience: item.audience,
            audienceId: item.audienceId,
            sms: item.sms,
          },
          { smsPaused: paused, onLimit: "skip" },
        );
        await tx
          .update(scheduledAnnouncements)
          .set({ status: "posted", announcementId: posted.id, note: posted.smsSkipped, updatedAt: now })
          .where(eq(scheduledAnnouncements.id, item.id));
        total.posted++;
      }
    });
  }
  return total;
}

export interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  audienceLabel: string;
  smsCount: number;
  pushCount: number;
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
        pushCount: announcements.pushCount,
        by: users.name,
        createdAt: announcements.createdAt,
        reads: sql<number>`(select count(*)::int from ${announcementReads} ar where ar.announcement_id = ${announcements.id})`,
      })
      .from(announcements)
      .innerJoin(users, eq(users.id, announcements.createdByUserId))
      .where(eq(announcements.tenantId, ctx.tenant.id))
      .orderBy(desc(announcements.createdAt))
      .limit(50);
    const label = await audienceLabels(tx, ctx.tenant.id, rows);
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      audienceLabel: label(r),
      smsCount: r.smsCount,
      pushCount: r.pushCount,
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
  const { levelIds, classIds, campusIds } = audienceKeys(mine);
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
