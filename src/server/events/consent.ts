import "server-only";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import { consentAnswers, consentForms, schoolEvents, users } from "../db/schema";
import { DomainError } from "../errors";
import {
  assertAudience,
  audienceFields,
  audienceLabels,
  familyReach,
  inAudience,
  type Audience,
} from "../messages/audience";
import { notifyFamilies, type NoticeResult } from "../messages/families";
import { schoolsForPhone } from "../parents/schools";
import { visibleClassIds } from "../students/service";
import type { TenantContext } from "../tenancy/service";
import { fullName, schoolRoster, type RosterRow } from "./roster";
import {
  CONSENT_ANSWERS,
  CONSENT_LIMITS,
  CONSENT_REMINDER_HOURS,
  consentOpen,
  formatEventWhen,
  type ConsentAnswer,
} from "@/lib/events";
import { todayIn } from "@/lib/format";

/**
 * Consent forms (CNS-01): the school's own wording, for an audience, attached to an event or on its own,
 * with a deadline. A guardian answers yes or no for each child from the parent view (signed in with their
 * verified number), or the office records a paper slip. Answers are never changed: a new answer is a new
 * row and the latest counts. Staff see who has not answered and remind those families.
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

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const uuid = z.string().uuid();
const formNotFound = () => new DomainError("consent_not_found", "Consent form not found.");

const formSchema = z.object({
  title: z
    .string()
    .trim()
    .min(2, "Give the form a title.")
    .max(CONSENT_LIMITS.title, "Use 100 characters or fewer."),
  body: z
    .string()
    .trim()
    .min(1, "Write what families are agreeing to.")
    .max(CONSENT_LIMITS.body, "Use 4,000 characters or fewer."),
  deadline: isoDate("Choose the last day for answers."),
  eventId: z.preprocess((v) => (v === "" || v === undefined ? null : v), uuid.nullable()),
  ...audienceFields,
  sms: z.boolean().default(false),
});

async function checkDeadline(
  tx: Transaction,
  tenantId: string,
  deadline: string,
  today: string,
  eventId: string | null,
) {
  if (deadline < today) throw new DomainError("consent_deadline", "That date has passed.", "deadline");
  if (deadline > addDays(today, 365))
    throw new DomainError("consent_deadline", "Choose a deadline within a year.", "deadline");
  if (!eventId) return null;
  const [event] = await tx
    .select()
    .from(schoolEvents)
    .where(and(eq(schoolEvents.tenantId, tenantId), eq(schoolEvents.id, eventId)));
  if (!event || event.cancelledAt || event.endsOn < today)
    throw new DomainError("consent_event", "Choose a coming event, or none.", "eventId");
  if (deadline > event.endsOn)
    throw new DomainError("consent_deadline", "The deadline must be on or before the event.", "deadline");
  return event;
}

/** Latest answer per student for some forms (answers are insert-only; the newest counts). */
async function latestAnswers(tx: Transaction, tenantId: string, formIds: string[]) {
  if (!formIds.length) return new Map<string, Map<string, LatestAnswer>>();
  const rows = await tx
    .select({
      formId: consentAnswers.formId,
      studentId: consentAnswers.studentId,
      answer: consentAnswers.answer,
      note: consentAnswers.note,
      source: consentAnswers.source,
      phone: consentAnswers.phone,
      guardianId: consentAnswers.guardianId,
      recordedBy: users.name,
      createdAt: consentAnswers.createdAt,
    })
    .from(consentAnswers)
    .leftJoin(users, eq(users.id, consentAnswers.recordedByUserId))
    .where(and(eq(consentAnswers.tenantId, tenantId), inArray(consentAnswers.formId, formIds)))
    .orderBy(asc(consentAnswers.createdAt), asc(consentAnswers.id));
  const byForm = new Map<string, Map<string, LatestAnswer>>();
  for (const r of rows) {
    const forForm = byForm.get(r.formId) ?? new Map<string, LatestAnswer>();
    const before = forForm.get(r.studentId);
    forForm.set(r.studentId, { ...r, answers: (before?.answers ?? 0) + 1 });
    byForm.set(r.formId, forForm);
  }
  return byForm;
}

interface LatestAnswer {
  answer: ConsentAnswer;
  note: string | null;
  source: "parent_view" | "office";
  phone: string | null;
  guardianId: string;
  recordedBy: string | null;
  createdAt: Date;
  /** How many answers were given for this child (more than one: it was changed). */
  answers: number;
}

/** The students a form is for (one entry each), limited to the classes this member may see. */
function studentsIn(
  roster: readonly RosterRow[],
  form: { audience: Audience; audienceId: string | null },
  visible: string[] | null,
) {
  const seen = new Map<string, RosterRow & { guardians: { id: string; name: string }[] }>();
  for (const r of roster) {
    if (!inAudience(r, form.audience, form.audienceId)) continue;
    if (visible !== null && (r.classId === null || !visible.includes(r.classId))) continue;
    const s = seen.get(r.studentId) ?? { ...r, guardians: [] };
    if (r.guardianId && r.guardianName) s.guardians.push({ id: r.guardianId, name: r.guardianName });
    seen.set(r.studentId, s);
  }
  return [...seen.values()];
}

async function notifyForForm(
  tx: Transaction,
  ctx: TenantContext,
  form: { id: string; title: string; deadline: string; audience: Audience; audienceId: string | null },
  input: { sms: boolean; onlyStudents?: Set<string>; key: string },
): Promise<NoticeResult> {
  const reach = (await familyReach(tx, ctx.tenant.id)).filter(
    (r) =>
      inAudience(r, form.audience, form.audienceId) &&
      (!input.onlyStudents || input.onlyStudents.has(r.studentId)),
  );
  return notifyFamilies(tx, {
    school: ctx.tenant,
    phones: [...new Set(reach.map((r) => r.phone))],
    sms: input.sms,
    smsPaused: ctx.billing.state === "limited",
    smsTemplate: "consent_request",
    smsPayload: {
      schoolName: ctx.tenant.name,
      title: form.title,
      deadline: formatEventWhen({
        startsOn: form.deadline,
        endsOn: form.deadline,
        startTime: null,
        endTime: null,
      }),
    },
    smsKind: "consent_request",
    pushTemplate: "consent_push",
    pushPayload: { schoolName: ctx.tenant.name },
    key: input.key,
    onLimit: "throw",
  });
}

/** A new consent form. Families with notifications on are told at once; SMS to the others when chosen. */
export async function createConsentForm(
  database: Database,
  ctx: TenantContext,
  input: unknown,
): Promise<{ id: string; sms: number; push: number }> {
  assertAllowed(ctx, "consent.manage");
  const data = formSchema.parse(input);
  const today = todayIn(ctx.tenant.timezone);
  return withTenant(database, scope(ctx), async (tx) => {
    await assertAudience(tx, ctx.tenant.id, data.audience, data.audienceId);
    await checkDeadline(tx, ctx.tenant.id, data.deadline, today, data.eventId);
    const [row] = await tx
      .insert(consentForms)
      .values({
        tenantId: ctx.tenant.id,
        eventId: data.eventId,
        title: data.title,
        body: data.body,
        deadline: data.deadline,
        audience: data.audience,
        audienceId: data.audienceId,
        createdByUserId: ctx.userId,
      })
      .returning();
    const form = row!;
    const sent = await notifyForForm(tx, ctx, form, { sms: data.sms, key: `consent:${form.id}:new` });
    await tx
      .update(consentForms)
      .set({ smsCount: sent.sms, pushCount: sent.push, lastRemindedAt: new Date() })
      .where(eq(consentForms.id, form.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "consent.form_created",
      entityType: "consent_form",
      entityId: form.id,
      metadata: {
        title: data.title,
        deadline: data.deadline,
        audience: data.audience,
        audienceId: data.audienceId,
        eventId: data.eventId,
        sms: sent.sms,
        push: sent.push,
      },
    });
    return { id: form.id, sms: sent.sms, push: sent.push };
  });
}

async function lockForm(tx: Transaction, tenantId: string, id: string) {
  if (!uuid.safeParse(id).success) return null;
  const [row] = await tx
    .select()
    .from(consentForms)
    .where(and(eq(consentForms.tenantId, tenantId), eq(consentForms.id, id)))
    .for("update");
  return row ?? null;
}

/** Moving the deadline (earlier or later); the wording never changes. */
export async function changeConsentDeadline(
  database: Database,
  ctx: TenantContext,
  id: string,
  input: unknown,
): Promise<void> {
  assertAllowed(ctx, "consent.manage");
  const { deadline } = z.object({ deadline: isoDate("Choose the last day for answers.") }).parse(input);
  const today = todayIn(ctx.tenant.timezone);
  await withTenant(database, scope(ctx), async (tx) => {
    const form = await lockForm(tx, ctx.tenant.id, id);
    if (!form) throw formNotFound();
    if (form.cancelledAt) throw new DomainError("consent_cancelled", "This form was cancelled.");
    await checkDeadline(tx, ctx.tenant.id, deadline, today, form.eventId);
    await tx
      .update(consentForms)
      .set({ deadline, updatedAt: new Date() })
      .where(eq(consentForms.id, form.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "consent.deadline_changed",
      entityType: "consent_form",
      entityId: form.id,
      metadata: { from: form.deadline, to: deadline },
    });
  });
}

export async function cancelConsentForm(database: Database, ctx: TenantContext, id: string): Promise<void> {
  assertAllowed(ctx, "consent.manage");
  await withTenant(database, scope(ctx), async (tx) => {
    const form = await lockForm(tx, ctx.tenant.id, id);
    if (!form) throw formNotFound();
    if (form.cancelledAt) return;
    const now = new Date();
    await tx
      .update(consentForms)
      .set({ cancelledAt: now, cancelledByUserId: ctx.userId, updatedAt: now })
      .where(eq(consentForms.id, form.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "consent.form_cancelled",
      entityType: "consent_form",
      entityId: form.id,
      metadata: { title: form.title },
    });
  });
}

/** Reminding the families of children with no answer yet; at most once a day per form. */
export async function remindConsentForm(
  database: Database,
  ctx: TenantContext,
  id: string,
  input: { sms: boolean },
  now = new Date(),
): Promise<{ families: number; sms: number; push: number }> {
  assertAllowed(ctx, "consent.manage");
  const today = todayIn(ctx.tenant.timezone, now);
  return withTenant(database, scope(ctx), async (tx) => {
    const form = await lockForm(tx, ctx.tenant.id, id);
    if (!form) throw formNotFound();
    if (!consentOpen(form.deadline, today, form.cancelledAt !== null))
      throw new DomainError("consent_closed", "This form is no longer taking answers.");
    if (
      form.lastRemindedAt &&
      now.getTime() - form.lastRemindedAt.getTime() < CONSENT_REMINDER_HOURS * 3_600_000
    )
      throw new DomainError(
        "consent_reminded",
        "Families were told about this form less than a day ago. Try again tomorrow.",
      );
    const answered = (await latestAnswers(tx, ctx.tenant.id, [form.id])).get(form.id) ?? new Map();
    const waiting = new Set(
      studentsIn(await schoolRoster(tx, ctx.tenant.id), form, null)
        .map((s) => s.studentId)
        .filter((sid) => !answered.has(sid)),
    );
    if (!waiting.size) throw new DomainError("consent_all_answered", "Every child has an answer.");
    const sent = await notifyForForm(tx, ctx, form, {
      sms: input.sms,
      onlyStudents: waiting,
      key: `consent:${form.id}:${now.getTime()}`,
    });
    await tx
      .update(consentForms)
      .set({
        smsCount: form.smsCount + sent.sms,
        pushCount: form.pushCount + sent.push,
        lastRemindedAt: now,
        updatedAt: now,
      })
      .where(eq(consentForms.id, form.id));
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "consent.reminder_sent",
      entityType: "consent_form",
      entityId: form.id,
      metadata: { children: waiting.size, sms: sent.sms, push: sent.push },
    });
    return { families: waiting.size, sms: sent.sms, push: sent.push };
  });
}

const answerSchema = z.object({
  answer: z.enum(CONSENT_ANSWERS, { message: "Choose yes or no." }),
  note: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.string().trim().max(CONSENT_LIMITS.note, "Use 300 characters or fewer.").nullable().optional(),
  ),
});

/**
 * The office records an answer given on paper, for a guardian of the child. Taken after the deadline too
 * (slips come in late), never for a cancelled form.
 */
export async function recordPaperAnswer(
  database: Database,
  ctx: TenantContext,
  formId: string,
  input: { studentId: unknown; guardianId: unknown; answer: unknown; note?: unknown },
): Promise<void> {
  assertAllowed(ctx, "consent.manage");
  const data = answerSchema.parse(input);
  const studentId = uuid.safeParse(input.studentId);
  const guardianId = uuid.safeParse(input.guardianId);
  if (!guardianId.success) throw new DomainError("consent_guardian", "Choose who signed it.", "guardianId");
  await withTenant(database, scope(ctx), async (tx) => {
    const form = await lockForm(tx, ctx.tenant.id, formId);
    if (!form) throw formNotFound();
    if (form.cancelledAt) throw new DomainError("consent_cancelled", "This form was cancelled.");
    const roster = studentId.success
      ? await schoolRoster(tx, ctx.tenant.id, { studentId: studentId.data })
      : [];
    const [child] = studentsIn(roster, form, await visibleClassIds(tx, ctx));
    if (!child) throw new DomainError("consent_student", "This child is not on the form.");
    if (!child.guardians.some((g) => g.id === guardianId.data))
      throw new DomainError("consent_guardian", "Choose one of the child's guardians.", "guardianId");
    await tx.insert(consentAnswers).values({
      tenantId: ctx.tenant.id,
      formId: form.id,
      studentId: child.studentId,
      guardianId: guardianId.data,
      answer: data.answer,
      note: data.note ?? null,
      source: "office",
      recordedByUserId: ctx.userId,
    });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "consent.paper_answer_recorded",
      entityType: "consent_form",
      entityId: form.id,
      metadata: { studentId: child.studentId, guardianId: guardianId.data, answer: data.answer },
    });
  });
}

export interface ConsentCounts {
  children: number;
  yes: number;
  no: number;
  waiting: number;
}

export interface ConsentFormRow {
  id: string;
  title: string;
  deadline: string;
  audienceLabel: string;
  eventTitle: string | null;
  cancelled: boolean;
  open: boolean;
  counts: ConsentCounts;
  by: string;
  createdAt: Date;
}

const countsFor = (
  kids: { studentId: string }[],
  answers: Map<string, LatestAnswer> | undefined,
): ConsentCounts => {
  let yes = 0;
  let no = 0;
  for (const k of kids) {
    const a = answers?.get(k.studentId)?.answer;
    if (a === "yes") yes++;
    else if (a === "no") no++;
  }
  return { children: kids.length, yes, no, waiting: kids.length - yes - no };
};

/** Every consent form with its answers so far (for teachers, only their classes' children). */
export async function listConsentForms(database: Database, ctx: TenantContext): Promise<ConsentFormRow[]> {
  assertAllowed(ctx, "consent.view");
  const today = todayIn(ctx.tenant.timezone);
  return withTenant(database, scope(ctx), async (tx) => {
    const forms = await tx
      .select({ f: consentForms, by: users.name, eventTitle: schoolEvents.title })
      .from(consentForms)
      .innerJoin(users, eq(users.id, consentForms.createdByUserId))
      .leftJoin(schoolEvents, eq(schoolEvents.id, consentForms.eventId))
      .where(eq(consentForms.tenantId, ctx.tenant.id))
      .orderBy(desc(consentForms.createdAt))
      .limit(100);
    if (!forms.length) return [];
    // One transaction runs one query at a time.
    const roster = await schoolRoster(tx, ctx.tenant.id);
    const visible = await visibleClassIds(tx, ctx);
    const answers = await latestAnswers(
      tx,
      ctx.tenant.id,
      forms.map((r) => r.f.id),
    );
    const label = await audienceLabels(
      tx,
      ctx.tenant.id,
      forms.map((r) => r.f),
    );
    return forms.map(({ f, by, eventTitle }) => ({
      id: f.id,
      title: f.title,
      deadline: f.deadline,
      audienceLabel: label(f),
      eventTitle,
      cancelled: f.cancelledAt !== null,
      open: consentOpen(f.deadline, today, f.cancelledAt !== null),
      counts: countsFor(studentsIn(roster, f, visible), answers.get(f.id)),
      by,
      createdAt: f.createdAt,
    }));
  });
}

export interface ConsentChildRow {
  studentId: string;
  name: string;
  admissionNumber: string;
  className: string | null;
  answer: ConsentAnswer | null;
  note: string | null;
  answeredAt: Date | null;
  /** "Ama Owusu, parent view" or "Ama Owusu, on paper (recorded by Kofi Asante)". */
  answeredBy: string | null;
  changed: boolean;
  guardians: { id: string; name: string }[];
}

export interface ConsentFormDetail {
  id: string;
  title: string;
  body: string;
  deadline: string;
  audienceLabel: string;
  event: { id: string; title: string; when: string } | null;
  cancelled: boolean;
  open: boolean;
  by: string;
  createdAt: Date;
  smsCount: number;
  pushCount: number;
  lastRemindedAt: Date | null;
  /** False within a day of the last notice. */
  canRemind: boolean;
  canManage: boolean;
  counts: ConsentCounts;
  children: ConsentChildRow[];
  classes: { id: string; name: string }[];
}

export async function getConsentForm(
  database: Database,
  ctx: TenantContext,
  id: string,
  options: { classId?: string; now?: Date } = {},
): Promise<ConsentFormDetail | null> {
  assertAllowed(ctx, "consent.view");
  if (!uuid.safeParse(id).success) return null;
  const now = options.now ?? new Date();
  const today = todayIn(ctx.tenant.timezone, now);
  return withTenant(database, scope(ctx), async (tx) => {
    const [row] = await tx
      .select({ f: consentForms, by: users.name })
      .from(consentForms)
      .innerJoin(users, eq(users.id, consentForms.createdByUserId))
      .where(and(eq(consentForms.tenantId, ctx.tenant.id), eq(consentForms.id, id)));
    if (!row) return null;
    const f = row.f;
    const [event] = f.eventId
      ? await tx.select().from(schoolEvents).where(eq(schoolEvents.id, f.eventId))
      : [];
    const roster = await schoolRoster(tx, ctx.tenant.id);
    const kids = studentsIn(roster, f, await visibleClassIds(tx, ctx));
    const answers = (await latestAnswers(tx, ctx.tenant.id, [f.id])).get(f.id);
    const guardianNames = new Map(
      roster.filter((r) => r.guardianId).map((r) => [r.guardianId!, r.guardianName!]),
    );
    const classes = [
      ...new Map(
        kids.filter((k) => k.classId).map((k) => [k.classId!, { id: k.classId!, name: k.className! }]),
      ).values(),
    ];
    const shown = options.classId ? kids.filter((k) => k.classId === options.classId) : kids;
    const open = consentOpen(f.deadline, today, f.cancelledAt !== null);
    return {
      id: f.id,
      title: f.title,
      body: f.body,
      deadline: f.deadline,
      audienceLabel: (await audienceLabels(tx, ctx.tenant.id, [f]))(f),
      event: event ? { id: event.id, title: event.title, when: formatEventWhen(event) } : null,
      cancelled: f.cancelledAt !== null,
      open,
      by: row.by,
      createdAt: f.createdAt,
      smsCount: f.smsCount,
      pushCount: f.pushCount,
      lastRemindedAt: f.lastRemindedAt,
      canRemind:
        open &&
        (!f.lastRemindedAt ||
          now.getTime() - f.lastRemindedAt.getTime() >= CONSENT_REMINDER_HOURS * 3_600_000),
      canManage: allowed(ctx, "consent.manage") && f.cancelledAt === null,
      counts: countsFor(kids, answers),
      classes,
      children: shown.map((k) => {
        const a = answers?.get(k.studentId);
        const who = a ? (guardianNames.get(a.guardianId) ?? "A guardian") : null;
        return {
          studentId: k.studentId,
          name: fullName(k),
          admissionNumber: k.admissionNumber,
          className: k.className,
          answer: a?.answer ?? null,
          note: a?.note ?? null,
          answeredAt: a?.createdAt ?? null,
          answeredBy: a
            ? a.source === "office"
              ? `${who}, on paper (recorded by ${a.recordedBy ?? "the office"})`
              : `${who}, parent view`
            : null,
          changed: (a?.answers ?? 0) > 1,
          guardians: k.guardians,
        };
      }),
    };
  });
}

// ——— The parent view ———

export interface ParentConsentChild {
  studentId: string;
  name: string;
  answer: { answer: ConsentAnswer; note: string | null; at: Date; byYou: boolean; onPaper: boolean } | null;
}

export interface ParentConsentForm {
  id: string;
  slug: string;
  schoolName: string;
  timezone: string;
  title: string;
  body: string;
  deadline: string;
  open: boolean;
  cancelled: boolean;
  event: { title: string; when: string; location: string | null } | null;
  children: ParentConsentChild[];
}

async function formsForPhone(
  tx: Transaction,
  school: { id: string; slug: string; name: string; timezone: string },
  phone: string,
  filter: { formId?: string; openOnly: boolean },
): Promise<ParentConsentForm[]> {
  const mine = (await schoolRoster(tx, school.id, { phone })).filter((r) => !r.portalBlocked);
  if (!mine.length) return [];
  const today = todayIn(school.timezone);
  const forms = await tx
    .select({ f: consentForms, e: schoolEvents })
    .from(consentForms)
    .leftJoin(schoolEvents, eq(schoolEvents.id, consentForms.eventId))
    .where(
      and(
        eq(consentForms.tenantId, school.id),
        filter.formId ? eq(consentForms.id, filter.formId) : undefined,
        filter.openOnly ? isNull(consentForms.cancelledAt) : undefined,
      ),
    )
    .orderBy(asc(consentForms.deadline))
    .limit(100);
  const relevant = forms
    .map(({ f, e }) => ({ f, e, kids: studentsIn(mine, f, null) }))
    .filter((r) => r.kids.length && (!filter.openOnly || consentOpen(r.f.deadline, today, false)));
  const answers = await latestAnswers(
    tx,
    school.id,
    relevant.map((r) => r.f.id),
  );
  return relevant.map(({ f, e, kids }) => ({
    id: f.id,
    slug: school.slug,
    schoolName: school.name,
    timezone: school.timezone,
    title: f.title,
    body: f.body,
    deadline: f.deadline,
    open: consentOpen(f.deadline, today, f.cancelledAt !== null),
    cancelled: f.cancelledAt !== null,
    event: e ? { title: e.title, when: formatEventWhen(e), location: e.location } : null,
    children: kids.map((k) => {
      const a = answers.get(f.id)?.get(k.studentId);
      return {
        studentId: k.studentId,
        name: k.firstName,
        answer: a
          ? {
              answer: a.answer,
              note: a.note,
              at: a.createdAt,
              byYou: a.phone === phone,
              onPaper: a.source === "office",
            }
          : null,
      };
    }),
  }));
}

/** For the family home: open forms at every school with a child still waiting for an answer. */
export async function listParentConsentForms(
  database: Database,
  phone: string,
): Promise<ParentConsentForm[]> {
  const result: ParentConsentForm[] = [];
  for (const school of await schoolsForPhone(database, phone)) {
    const forms = await withTenant(database, { tenantId: school.id, userId: "" }, (tx) =>
      formsForPhone(tx, school, phone, { openOnly: true }),
    );
    result.push(...forms.filter((f) => f.children.some((c) => !c.answer)));
  }
  return result;
}

/** A school's open forms for this number (answered or not), for its events page. */
export async function listSchoolConsentForms(
  database: Database,
  phone: string,
  slug: string,
): Promise<ParentConsentForm[]> {
  const school = (await schoolsForPhone(database, phone)).find((s) => s.slug === slug);
  if (!school) return [];
  return withTenant(database, { tenantId: school.id, userId: "" }, (tx) =>
    formsForPhone(tx, school, phone, { openOnly: true }),
  );
}

export async function getParentConsentForm(
  database: Database,
  phone: string,
  slug: string,
  formId: string,
): Promise<ParentConsentForm | null> {
  if (!uuid.safeParse(formId).success) return null;
  const school = (await schoolsForPhone(database, phone)).find((s) => s.slug === slug);
  if (!school) return null;
  const [form] = await withTenant(database, { tenantId: school.id, userId: "" }, (tx) =>
    formsForPhone(tx, school, phone, { formId, openOnly: false }),
  );
  return form ?? null;
}

/**
 * A guardian answers for one child from the parent view. The number is the one they signed in with (verified
 * by SMS code); it is kept with the answer. Pressing the same answer again records nothing new.
 */
export async function answerParentConsent(
  database: Database,
  phone: string,
  input: { slug: string; formId: string; studentId: string; answer: unknown; note?: unknown },
): Promise<{ changed: boolean }> {
  const data = answerSchema.parse({ answer: input.answer, note: input.note });
  const school = (await schoolsForPhone(database, phone)).find((s) => s.slug === input.slug);
  if (!school || !uuid.safeParse(input.formId).success || !uuid.safeParse(input.studentId).success)
    throw formNotFound();
  return withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => {
    const form = await lockForm(tx, school.id, input.formId);
    if (!form) throw formNotFound();
    if (!consentOpen(form.deadline, todayIn(school.timezone), form.cancelledAt !== null))
      throw new DomainError(
        "consent_closed",
        form.cancelledAt
          ? "The school cancelled this form."
          : "The deadline for answers has passed. Please contact the school.",
      );
    const mine = (await schoolRoster(tx, school.id, { phone, studentId: input.studentId })).filter(
      (r) => !r.portalBlocked,
    );
    const [child] = studentsIn(mine, form, null);
    const guardianId = child?.guardians[0]?.id;
    if (!child || !guardianId) throw formNotFound();
    const before = (await latestAnswers(tx, school.id, [form.id])).get(form.id)?.get(child.studentId);
    const note = data.note ?? null;
    if (before && before.phone === phone && before.answer === data.answer && before.note === note)
      return { changed: false };
    await tx.insert(consentAnswers).values({
      tenantId: school.id,
      formId: form.id,
      studentId: child.studentId,
      guardianId,
      answer: data.answer,
      note,
      source: "parent_view",
      phone,
    });
    return { changed: true };
  });
}
