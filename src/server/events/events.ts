import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import { readBillingState } from "../billing/state";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { consentForms, schoolEvents, tenants, users } from "../db/schema";
import { DomainError } from "../errors";
import {
  assertAudience,
  audienceFields,
  audienceKeys,
  audienceLabels,
  familyReach,
  phonesFor,
  type Audience,
} from "../messages/audience";
import { notifyFamilies } from "../messages/families";
import { schoolsForPhone } from "../parents/schools";
import type { TenantContext } from "../tenancy/service";
import { academicCalendar, schoolRoster, type CalendarEntry } from "./roster";
import {
  EVENT_LIMITS,
  EVENT_REMINDER_HOUR,
  EVENT_REMINDERS,
  formatEventWhen,
  reminderDate,
  type EventReminder,
} from "@/lib/events";
import { todayIn } from "@/lib/format";
import { normaliseTime } from "@/lib/timetable";

/**
 * School events (EVT-01): for the whole school, a campus, a level or a class, shown in the parent view, with
 * an optional reminder the worker sends on the chosen day (push to phones with notifications on, and SMS to
 * the other families when chosen). Events are edited while they are coming and cancelled, never deleted.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

const isoDate = (message: string) =>
  z
    .string({ message })
    .regex(/^\d{4}-\d{2}-\d{2}$/, message)
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), message);

const optionalText = (max: number, message: string) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(max, message).nullable().optional(),
  );

const optionalTime = z.preprocess(
  (v) => (v === "" || v === undefined || v === null ? null : v),
  z
    .string()
    .nullable()
    .transform((v, c) => {
      if (v === null) return null;
      const t = normaliseTime(v);
      if (!t) c.addIssue({ code: "custom", message: "Enter a time such as 10:00." });
      return t;
    }),
);

const eventSchema = z.object({
  title: z
    .string()
    .trim()
    .min(2, "Give the event a name.")
    .max(EVENT_LIMITS.title, "Use 100 characters or fewer."),
  details: optionalText(EVENT_LIMITS.details, "Use 2,000 characters or fewer."),
  location: optionalText(EVENT_LIMITS.location, "Use 120 characters or fewer."),
  startsOn: isoDate("Choose the day it starts."),
  endsOn: z.preprocess((v) => (v === "" ? undefined : v), isoDate("Choose the last day.").optional()),
  startTime: optionalTime,
  endTime: optionalTime,
  ...audienceFields,
  reminder: z.enum(EVENT_REMINDERS).default("none"),
  reminderDaysBefore: z.coerce.number().int().min(1).max(14).default(1),
});

export type EventInput = z.input<typeof eventSchema>;

function parseEvent(input: unknown, today: string) {
  const data = eventSchema.parse(input);
  const endsOn = data.endsOn ?? data.startsOn;
  if (endsOn < data.startsOn)
    throw new DomainError("event_dates", "The last day must be on or after the first.", "endsOn");
  if ((Date.parse(endsOn) - Date.parse(data.startsOn)) / 86_400_000 > 60)
    throw new DomainError("event_dates", "An event can last up to 60 days.", "endsOn");
  if (endsOn < today) throw new DomainError("event_past", "That date has passed.", "startsOn");
  if (data.endTime && !data.startTime)
    throw new DomainError("event_times", "Give the start time too.", "startTime");
  if (data.endTime && data.startTime && endsOn === data.startsOn && data.endTime <= data.startTime)
    throw new DomainError("event_times", "It must end after it starts.", "endTime");
  return { ...data, endsOn, details: data.details ?? null, location: data.location ?? null };
}

export async function createEvent(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<{ id: string }> {
  assertAllowed(ctx, "events.manage");
  const data = parseEvent(input, todayIn(ctx.tenant.timezone));
  return withTenant(database, scope(ctx), async (tx) => {
    await assertAudience(tx, ctx.tenant.id, data.audience, data.audienceId);
    const [row] = await tx
      .insert(schoolEvents)
      .values({ tenantId: ctx.tenant.id, ...data, createdByUserId: ctx.userId })
      .returning({ id: schoolEvents.id });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "event.created",
      entityType: "school_event",
      entityId: row!.id,
      metadata: {
        title: data.title,
        startsOn: data.startsOn,
        audience: data.audience,
        reminder: data.reminder,
      },
    });
    return { id: row!.id };
  });
}

async function lockEvent(tx: Transaction, tenantId: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) return null;
  const [row] = await tx
    .select()
    .from(schoolEvents)
    .where(and(eq(schoolEvents.tenantId, tenantId), eq(schoolEvents.id, id)))
    .for("update");
  return row ?? null;
}

const notFound = () => new DomainError("event_not_found", "Event not found.");

/** Changing a coming event. A new date (or reminder) means the reminder goes again, on its new day. */
export async function updateEvent(
  database: Database,
  ctx: TenantContext,
  id: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "events.manage");
  const today = todayIn(ctx.tenant.timezone);
  const data = parseEvent(input, today);
  await withTenant(database, scope(ctx), async (tx) => {
    const event = await lockEvent(tx, ctx.tenant.id, id);
    if (!event) throw notFound();
    if (event.cancelledAt) throw new DomainError("event_cancelled", "This event was cancelled.");
    if (event.endsOn < today) throw new DomainError("event_past", "This event is over.");
    await assertAudience(tx, ctx.tenant.id, data.audience, data.audienceId);
    const remindAgain =
      data.startsOn !== event.startsOn ||
      data.reminder !== event.reminder ||
      data.reminderDaysBefore !== event.reminderDaysBefore;
    await tx
      .update(schoolEvents)
      .set({ ...data, ...(remindAgain ? { remindedAt: null } : {}), updatedAt: new Date() })
      .where(eq(schoolEvents.id, event.id));
    const changed = (Object.keys(data) as (keyof typeof data)[]).filter((k) => data[k] !== event[k]);
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "event.updated",
      entityType: "school_event",
      entityId: event.id,
      metadata: {
        title: data.title,
        changes: Object.fromEntries(changed.map((k) => [k, { from: event[k], to: data[k] }])),
      },
    });
  });
}

/** Cancelling an event, with any consent forms still open for it. */
export async function cancelEvent(
  database: Database,
  ctx: TenantContext,
  id: string,
): Promise<{ forms: number }> {
  assertAllowed(ctx, "events.manage");
  return withTenant(database, scope(ctx), async (tx) => {
    const event = await lockEvent(tx, ctx.tenant.id, id);
    if (!event) throw notFound();
    if (event.cancelledAt) return { forms: 0 };
    const now = new Date();
    await tx
      .update(schoolEvents)
      .set({ cancelledAt: now, cancelledByUserId: ctx.userId, updatedAt: now })
      .where(eq(schoolEvents.id, event.id));
    const forms = await tx
      .update(consentForms)
      .set({ cancelledAt: now, cancelledByUserId: ctx.userId, updatedAt: now })
      .where(
        and(
          eq(consentForms.tenantId, ctx.tenant.id),
          eq(consentForms.eventId, event.id),
          isNull(consentForms.cancelledAt),
        ),
      )
      .returning({ id: consentForms.id });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "event.cancelled",
      entityType: "school_event",
      entityId: event.id,
      metadata: { title: event.title, startsOn: event.startsOn, consentForms: forms.map((f) => f.id) },
    });
    return { forms: forms.length };
  });
}

export interface EventRow {
  id: string;
  title: string;
  details: string | null;
  location: string | null;
  startsOn: string;
  endsOn: string;
  startTime: string | null;
  endTime: string | null;
  audience: Audience;
  audienceId: string | null;
  audienceLabel: string;
  reminder: EventReminder;
  reminderDaysBefore: number;
  remindedAt: Date | null;
  reminderSmsCount: number;
  reminderPushCount: number;
  cancelled: boolean;
  by: string;
  /** Consent forms attached to it. */
  forms: number;
}

export interface EventList {
  today: string;
  events: EventRow[];
  /** Term dates and holidays in the same span. */
  calendar: CalendarEntry[];
}

/** How far ahead the calendar reaches, and how far back "past events" go. */
const AHEAD_DAYS = 370;
const PAST_DAYS = 120;

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** Coming events (or the last few months' when `past`), with the school calendar alongside. */
export async function listEvents(
  database: Database,
  ctx: TenantContext,
  options: { past?: boolean } = {},
): Promise<EventList> {
  assertAllowed(ctx, "events.view");
  const today = todayIn(ctx.tenant.timezone);
  const [from, to] = options.past
    ? [addDays(today, -PAST_DAYS), addDays(today, -1)]
    : [today, addDays(today, AHEAD_DAYS)];
  return withTenant(database, scope(ctx), async (tx) => {
    const rows = await tx
      .select({
        e: schoolEvents,
        by: users.name,
        forms: sql<number>`(select count(*)::int from ${consentForms} f where f.event_id = ${schoolEvents.id})`,
      })
      .from(schoolEvents)
      .innerJoin(users, eq(users.id, schoolEvents.createdByUserId))
      .where(
        and(
          eq(schoolEvents.tenantId, ctx.tenant.id),
          options.past
            ? and(lt(schoolEvents.endsOn, today), gte(schoolEvents.endsOn, from))
            : and(gte(schoolEvents.endsOn, today), sql`${schoolEvents.startsOn} <= ${to}`),
        ),
      )
      .orderBy(
        options.past ? desc(schoolEvents.startsOn) : asc(schoolEvents.startsOn),
        asc(schoolEvents.startTime),
      )
      .limit(300);
    const label = await audienceLabels(
      tx,
      ctx.tenant.id,
      rows.map((r) => r.e),
    );
    const calendar = await academicCalendar(tx, ctx.tenant.id, from, to);
    return {
      today,
      events: rows.map(({ e, by, forms }) => ({
        id: e.id,
        title: e.title,
        details: e.details,
        location: e.location,
        startsOn: e.startsOn,
        endsOn: e.endsOn,
        startTime: e.startTime,
        endTime: e.endTime,
        audience: e.audience,
        audienceId: e.audienceId,
        audienceLabel: label(e),
        reminder: e.reminder,
        reminderDaysBefore: e.reminderDaysBefore,
        remindedAt: e.remindedAt,
        reminderSmsCount: e.reminderSmsCount,
        reminderPushCount: e.reminderPushCount,
        cancelled: e.cancelledAt !== null,
        by,
        forms,
      })),
      calendar: options.past ? calendar.reverse() : calendar,
    };
  });
}

/** Coming events a consent form can be attached to. */
export async function listEventChoices(
  database: Database,
  ctx: TenantContext,
): Promise<{ id: string; title: string; startsOn: string; audience: Audience; audienceId: string | null }[]> {
  assertAllowed(ctx, "consent.manage");
  const today = todayIn(ctx.tenant.timezone);
  return withTenant(database, scope(ctx), (tx) =>
    tx
      .select({
        id: schoolEvents.id,
        title: schoolEvents.title,
        startsOn: schoolEvents.startsOn,
        audience: schoolEvents.audience,
        audienceId: schoolEvents.audienceId,
      })
      .from(schoolEvents)
      .where(
        and(
          eq(schoolEvents.tenantId, ctx.tenant.id),
          isNull(schoolEvents.cancelledAt),
          gte(schoolEvents.endsOn, today),
        ),
      )
      .orderBy(asc(schoolEvents.startsOn))
      .limit(100),
  );
}

// ——— Reminders (worker) ———

/**
 * Sends the reminders due today: for each school (after EVENT_REMINDER_HOUR school time), each coming event
 * whose reminder day has come and that has not been reminded. A push to phones with notifications on, and
 * SMS to the other families when the event says so, within the plan's allowance (otherwise push only).
 */
export async function runEventReminders(
  database: Database,
  now = new Date(),
): Promise<{ events: number; sms: number; push: number }> {
  const schools = await database
    .select({
      id: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      timezone: tenants.timezone,
      isDemo: tenants.isDemo,
    })
    .from(tenants)
    .where(and(eq(tenants.status, "active"), eq(tenants.isDemo, false)));
  const total = { events: 0, sms: 0, push: 0 };
  for (const school of schools) {
    const hour = new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: school.timezone,
    }).format(now);
    if (Number(hour) < EVENT_REMINDER_HOUR) continue;
    const today = todayIn(school.timezone, now);
    await withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"event-reminders:" + school.id}, 0))`,
      );
      const due = (
        await tx
          .select()
          .from(schoolEvents)
          .where(
            and(
              eq(schoolEvents.tenantId, school.id),
              isNull(schoolEvents.cancelledAt),
              isNull(schoolEvents.remindedAt),
              ne(schoolEvents.reminder, "none"),
              gte(schoolEvents.startsOn, today),
            ),
          )
      ).filter((e) => reminderDate(e.startsOn, e.reminderDaysBefore) <= today);
      if (!due.length) return;
      const reach = await familyReach(tx, school.id);
      const paused = (await readBillingState(tx, school)).state === "limited";
      for (const event of due) {
        const sent = await notifyFamilies(tx, {
          school,
          phones: phonesFor(reach, event.audience, event.audienceId),
          sms: event.reminder === "sms",
          smsPaused: paused,
          smsTemplate: "event_reminder",
          smsPayload: {
            schoolName: school.name,
            title: event.title,
            when: formatEventWhen(event),
            location: event.location,
          },
          smsKind: "event_reminder",
          pushTemplate: "event_push",
          pushPayload: { schoolName: school.name, schoolSlug: school.slug },
          key: `event:${event.id}:${event.startsOn}`,
          onLimit: "skip",
        });
        await tx
          .update(schoolEvents)
          .set({ remindedAt: now, reminderSmsCount: sent.sms, reminderPushCount: sent.push })
          .where(eq(schoolEvents.id, event.id));
        await recordAudit(tx, {
          tenantId: school.id,
          actorUserId: null,
          action: "event.reminder_sent",
          entityType: "school_event",
          entityId: event.id,
          metadata: { sms: sent.sms, push: sent.push, smsSkipped: sent.smsSkipped },
        });
        total.events++;
        total.sms += sent.sms;
        total.push += sent.push;
      }
    });
  }
  return total;
}

// ——— The parent view ———

export interface ParentEvent {
  id: string;
  title: string;
  details: string | null;
  location: string | null;
  startsOn: string;
  endsOn: string;
  startTime: string | null;
  endTime: string | null;
  cancelled: boolean;
  /** Which of this family's children it is for (empty: the whole school). */
  for: string[];
}

export interface ParentEventsPage {
  name: string;
  today: string;
  events: ParentEvent[];
  calendar: CalendarEntry[];
}

/** Events reaching this number's children at one school, inside its tenant transaction. */
export async function eventsForParent(
  tx: Transaction,
  tenantId: string,
  phone: string,
  today: string,
  to: string,
): Promise<ParentEvent[]> {
  const mine = (await schoolRoster(tx, tenantId, { phone })).filter((r) => !r.portalBlocked);
  if (!mine.length) return [];
  const { levelIds, classIds, campusIds } = audienceKeys(mine);
  const rows = await tx
    .select()
    .from(schoolEvents)
    .where(
      and(
        eq(schoolEvents.tenantId, tenantId),
        gte(schoolEvents.endsOn, today),
        sql`${schoolEvents.startsOn} <= ${to}`,
        or(
          eq(schoolEvents.audience, "school"),
          levelIds.length
            ? and(eq(schoolEvents.audience, "level"), inArray(schoolEvents.audienceId, levelIds))
            : undefined,
          classIds.length
            ? and(eq(schoolEvents.audience, "class"), inArray(schoolEvents.audienceId, classIds))
            : undefined,
          campusIds.length
            ? and(eq(schoolEvents.audience, "campus"), inArray(schoolEvents.audienceId, campusIds))
            : undefined,
        ),
      ),
    )
    .orderBy(asc(schoolEvents.startsOn), asc(schoolEvents.startTime))
    .limit(100);
  return rows.map((e) => ({
    id: e.id,
    title: e.title,
    details: e.details,
    location: e.location,
    startsOn: e.startsOn,
    endsOn: e.endsOn,
    startTime: e.startTime,
    endTime: e.endTime,
    cancelled: e.cancelledAt !== null,
    for:
      e.audience === "school"
        ? []
        : [
            ...new Set(
              mine
                .filter(
                  (r) =>
                    (e.audience === "level" ? r.levelId : e.audience === "class" ? r.classId : r.campusId) ===
                    e.audienceId,
                )
                .map((r) => r.firstName),
            ),
          ],
  }));
}

/** A school's coming events for this number's children, with its term dates and holidays. */
export async function getParentEvents(
  database: Database,
  phone: string,
  slug: string,
): Promise<ParentEventsPage | null> {
  const school = (await schoolsForPhone(database, phone)).find((s) => s.slug === slug);
  if (!school) return null;
  const today = todayIn(school.timezone);
  const to = addDays(today, 200);
  return withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => ({
    name: school.name,
    today,
    events: await eventsForParent(tx, school.id, phone, today, to),
    calendar: await academicCalendar(tx, school.id, today, to),
  }));
}
