import { randomBytes, randomInt } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listTeacherOptions, updateClass } from "@/server/academics/classes";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { consentAnswers, consentForms, notificationOutbox, schoolEvents, smsUsage } from "@/server/db/schema";
import {
  answerParentConsent,
  cancelConsentForm,
  changeConsentDeadline,
  createConsentForm,
  getConsentForm,
  getParentConsentForm,
  listConsentForms,
  listParentConsentForms,
  recordPaperAnswer,
  remindConsentForm,
} from "@/server/events/consent";
import {
  cancelEvent,
  createEvent,
  getParentEvents,
  listEvents,
  runEventReminders,
  updateEvent,
} from "@/server/events/events";
import { exportDataset } from "@/server/export/datasets";
import { savePushSubscription } from "@/server/parents/push";
import { createParentSession, validateParentSession } from "@/server/parents/sessions";
import { addGuardian } from "@/server/students/guardians";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { normalizePhone } from "@/lib/phone";
import { todayIn } from "@/lib/format";
import { conn, school, type School } from "../support/mobile-money";

const KEY = "BA" + randomBytes(60).toString("base64url");
beforeAll(() => {
  process.env.VAPID_PUBLIC_KEY = KEY;
});
afterAll(async () => {
  delete process.env.VAPID_PUBLIC_KEY;
  await conn.close();
});

const randomPhone = () => normalizePhone(`024${String(randomInt(0, 10_000_000)).padStart(7, "0")}`)!;
const asSchool = <T>(s: School, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: "" }, fn);
const dbRefused = (pattern: RegExp) => (error: unknown) =>
  pattern.test(
    String((error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message),
  );

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** A child in a class with one guardian; the guardian's number in +233 form. */
async function family(s: School, name: string, classId: string) {
  const student = await s.add(name, classId);
  const phone = randomPhone();
  await addGuardian(conn.app, s.owner, student.id, {
    fullName: `${name}'s mother`,
    phone,
    relationship: "mother",
  });
  return { studentId: student.id, phone };
}

async function withPush(phone: string) {
  const { token } = await createParentSession(conn.app, phone);
  const session = (await validateParentSession(conn.app, token))!;
  await savePushSubscription(conn.app, session, {
    endpoint: `https://push.example.test/send/${randomBytes(12).toString("hex")}`,
    keys: {
      p256dh: "B" + randomBytes(64).toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  });
}

const outboxFor = (recipients: string[], template: string) =>
  conn.owner
    .select()
    .from(notificationOutbox)
    .where(and(inArray(notificationOutbox.recipient, recipients), eq(notificationOutbox.template, template)));

async function classTeacher(s: School, classId: string, name: string) {
  const options = await listTeacherOptions(conn.app, s.owner);
  const teacher = options.find((t) => t.name === "Teacher")!;
  await updateClass(conn.app, s.owner, classId, { name, classTeacherMembershipId: teacher.membershipId });
  return (await resolveTenantContext(conn.app, s.tenant.slug, s.teacher.userId)) as TenantContext;
}

describe("school events", () => {
  it("are shown to the families of the children they are for, and checked when added", async () => {
    const s = await school();
    const today = todayIn(s.tenant.timezone);
    const a = await family(s, "Adjoa", s.classA);
    const b = await family(s, "Baaba", s.classB);
    const forA = await createEvent(conn.app, s.head, {
      title: "Basic 4A trip",
      startsOn: addDays(today, 5),
      startTime: "8:30",
      endTime: "15:00",
      location: "Cape Coast Castle",
      audience: "class",
      audienceId: s.classA,
    });
    await createEvent(conn.app, s.head, {
      title: "Sports day",
      startsOn: addDays(today, 10),
      endsOn: addDays(today, 11),
      audience: "school",
      audienceId: null,
    });
    const seenByA = (await getParentEvents(conn.app, a.phone, s.tenant.slug))!;
    expect(seenByA.events.map((e) => [e.title, e.for])).toEqual([
      ["Basic 4A trip", ["Adjoa"]],
      ["Sports day", []],
    ]);
    expect(seenByA.events[0]).toMatchObject({
      startTime: "08:30",
      endTime: "15:00",
      location: "Cape Coast Castle",
    });
    expect((await getParentEvents(conn.app, b.phone, s.tenant.slug))!.events.map((e) => e.title)).toEqual([
      "Sports day",
    ]);
    expect((await listEvents(conn.app, s.teacher)).events.map((e) => e.title)).toEqual([
      "Basic 4A trip",
      "Sports day",
    ]);

    const bad = (input: Record<string, unknown>) =>
      createEvent(conn.app, s.head, { title: "Open day", audience: "school", audienceId: null, ...input });
    await expect(bad({ startsOn: addDays(today, -2) })).rejects.toMatchObject({ code: "event_past" });
    await expect(bad({ startsOn: addDays(today, 3), endsOn: addDays(today, 2) })).rejects.toMatchObject({
      code: "event_dates",
    });
    await expect(bad({ startsOn: addDays(today, 3), endTime: "10:00" })).rejects.toMatchObject({
      code: "event_times",
    });
    await expect(
      bad({ startsOn: addDays(today, 3), startTime: "10:00", endTime: "09:00" }),
    ).rejects.toMatchObject({
      code: "event_times",
    });
    await expect(
      bad({ startsOn: addDays(today, 3), audience: "class", audienceId: null }),
    ).rejects.toMatchObject({
      code: "audience_invalid",
    });
    // Teachers see the calendar but do not add to it.
    await expect(
      createEvent(conn.app, s.teacher, { title: "x", startsOn: today, audience: "school" }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // Cancelled: families see it as cancelled; it never changes again, and it is never deleted.
    await cancelEvent(conn.app, s.head, forA.id);
    expect((await getParentEvents(conn.app, a.phone, s.tenant.slug))!.events[0]).toMatchObject({
      title: "Basic 4A trip",
      cancelled: true,
    });
    await expect(
      updateEvent(conn.app, s.head, forA.id, {
        title: "Back on",
        startsOn: addDays(today, 6),
        audience: "school",
      }),
    ).rejects.toMatchObject({ code: "event_cancelled" });
    await expect(
      asSchool(s, (tx) =>
        tx.update(schoolEvents).set({ title: "Changed" }).where(eq(schoolEvents.id, forA.id)),
      ),
    ).rejects.toSatisfy(dbRefused(/cancelled record/));
    await expect(
      asSchool(s, (tx) => tx.delete(schoolEvents).where(eq(schoolEvents.id, forA.id))),
    ).rejects.toThrow();
  });

  it("remind families on the chosen day: push where it is on, SMS to the others, once", async () => {
    const s = await school();
    const today = todayIn(s.tenant.timezone);
    const pushed = await family(s, "Akua", s.classA);
    const bySms = await family(s, "Esi", s.classA);
    const elsewhere = await family(s, "Efua", s.classB);
    await withPush(pushed.phone);
    const { id } = await createEvent(conn.app, s.head, {
      title: "PTA meeting",
      startsOn: addDays(today, 1),
      startTime: "10:00",
      location: "the school hall",
      audience: "campus",
      audienceId: await campusOf(s, s.classA),
      reminder: "sms",
      reminderDaysBefore: 1,
    });
    const early = new Date(`${today}T06:00:00Z`);
    expect((await runEventReminders(conn.app, early)).events).toBe(0);
    const noon = new Date(`${today}T12:00:00Z`);
    await runEventReminders(conn.app, noon);
    const sms = await outboxFor([pushed.phone, bySms.phone, elsewhere.phone], "event_reminder");
    expect(sms.map((m) => m.recipient)).toEqual([bySms.phone]);
    const [event] = await asSchool(s, (tx) => tx.select().from(schoolEvents).where(eq(schoolEvents.id, id)));
    expect(event).toMatchObject({ reminderSmsCount: 1, reminderPushCount: 1 });
    expect(event!.remindedAt).not.toBeNull();
    const usage = await asSchool(s, (tx) =>
      tx
        .select()
        .from(smsUsage)
        .where(and(eq(smsUsage.tenantId, s.tenant.id), eq(smsUsage.kind, "event_reminder"))),
    );
    expect(usage).toHaveLength(1);
    // Never twice for the same day.
    await runEventReminders(conn.app, new Date(noon.getTime() + 3_600_000));
    expect(await outboxFor([bySms.phone], "event_reminder")).toHaveLength(1);
    // Moved to another day: reminded again on the new day.
    await updateEvent(conn.app, s.head, id, {
      title: "PTA meeting",
      startsOn: addDays(today, 2),
      startTime: "10:00",
      audience: "school",
      reminder: "push",
      reminderDaysBefore: 2,
    });
    await runEventReminders(conn.app, noon);
    expect(await outboxFor([bySms.phone], "event_reminder")).toHaveLength(1);
    // (Push counts are not checked again: other test files dispatch the shared outbox, and their fake
    // push service can report this phone's subscription gone.)
    const [again] = await asSchool(s, (tx) => tx.select().from(schoolEvents).where(eq(schoolEvents.id, id)));
    expect(again!.remindedAt!.getTime()).toBe(noon.getTime());
    expect(again!.reminderSmsCount).toBe(0);
  });
});

async function campusOf(s: School, classId: string) {
  const { classes } = await import("@/server/db/schema");
  const [row] = await asSchool(s, (tx) =>
    tx.select({ id: classes.campusId }).from(classes).where(eq(classes.id, classId)),
  );
  return row!.id;
}

describe("consent forms", () => {
  it("collect one answer per child, the latest counting, and show who has not answered", async () => {
    const s = await school();
    const today = todayIn(s.tenant.timezone);
    const a = await family(s, "Ama", s.classA);
    const b = await family(s, "Abena", s.classA);
    const other = await family(s, "Afia", s.classB);
    // A second guardian for Ama.
    const father = randomPhone();
    await addGuardian(conn.app, s.owner, a.studentId, {
      fullName: "Ama's father",
      phone: father,
      relationship: "father",
    });
    await withPush(b.phone);
    const trip = await createEvent(conn.app, s.head, {
      title: "Museum trip",
      startsOn: addDays(today, 7),
      audience: "class",
      audienceId: s.classA,
    });
    await expect(
      createConsentForm(conn.app, s.head, {
        title: "Museum trip",
        body: "Your child will visit the National Museum by bus.",
        deadline: addDays(today, 9),
        eventId: trip.id,
        audience: "class",
        audienceId: s.classA,
      }),
    ).rejects.toMatchObject({ code: "consent_deadline" });
    const form = await createConsentForm(conn.app, s.head, {
      title: "Museum trip",
      body: "Your child will visit the National Museum by bus. Cost: GH₵20.",
      deadline: addDays(today, 5),
      eventId: trip.id,
      audience: "class",
      audienceId: s.classA,
      sms: true,
    });
    // Push to Abena's mother (notifications on), SMS to Ama's guardians; nothing to the other class.
    expect(form).toMatchObject({ push: 1, sms: 2 });
    const sms = await outboxFor([a.phone, father, b.phone, other.phone], "consent_request");
    expect(sms.map((m) => m.recipient).sort()).toEqual([a.phone, father].sort());
    expect(sms[0]!.idempotencyKey).toMatch(/^consent:/);

    // Parents see it on their home until each child of theirs has an answer.
    const home = await listParentConsentForms(conn.app, a.phone);
    expect(home.map((f) => [f.title, f.children.map((c) => c.name)])).toEqual([["Museum trip", ["Ama"]]]);
    expect(await listParentConsentForms(conn.app, other.phone)).toEqual([]);
    const ask = (phone: string, answer: string, note?: string, studentId = a.studentId) =>
      answerParentConsent(conn.app, phone, { slug: s.tenant.slug, formId: form.id, studentId, answer, note });
    expect(await ask(a.phone, "yes", "Allergic to peanuts")).toEqual({ changed: true });
    expect(await ask(a.phone, "yes", "Allergic to peanuts")).toEqual({ changed: false });
    expect(await listParentConsentForms(conn.app, a.phone)).toEqual([]);
    // A parent cannot answer for a child who is not theirs.
    await expect(ask(other.phone, "yes", undefined, a.studentId)).rejects.toMatchObject({
      code: "consent_not_found",
    });
    await expect(ask(a.phone, "maybe")).rejects.toThrow();
    // The other guardian changes the answer: the latest counts, and both are kept.
    await ask(father, "no");
    const seen = (await getParentConsentForm(conn.app, a.phone, s.tenant.slug, form.id))!;
    expect(seen.children[0]!.answer).toMatchObject({ answer: "no", byYou: false, onPaper: false });

    // Staff: counts and each child's latest answer.
    const detail = (await getConsentForm(conn.app, s.head, form.id))!;
    expect(detail.counts).toEqual({ children: 2, yes: 0, no: 1, waiting: 1 });
    const ama = detail.children.find((c) => c.studentId === a.studentId)!;
    expect(ama).toMatchObject({ answer: "no", changed: true, answeredBy: "Ama's father, parent view" });
    expect(detail.event?.title).toBe("Museum trip");

    // Abena's slip comes in on paper.
    const abena = detail.children.find((c) => c.studentId === b.studentId)!;
    await recordPaperAnswer(conn.app, s.head, form.id, {
      studentId: b.studentId,
      guardianId: abena.guardians[0]!.id,
      answer: "yes",
      note: "Signed slip",
    });
    await expect(
      recordPaperAnswer(conn.app, s.head, form.id, {
        studentId: other.studentId,
        guardianId: abena.guardians[0]!.id,
        answer: "yes",
      }),
    ).rejects.toMatchObject({ code: "consent_student" });
    const after = (await getConsentForm(conn.app, s.head, form.id))!;
    expect(after.counts).toEqual({ children: 2, yes: 1, no: 1, waiting: 0 });
    expect(after.children.find((c) => c.studentId === b.studentId)!.answeredBy).toMatch(
      /on paper \(recorded by Head\)/,
    );
    expect((await listConsentForms(conn.app, s.head))[0]!.counts).toEqual(after.counts);

    // Answers are never changed or removed, even directly in the database.
    await expect(
      asSchool(s, (tx) =>
        tx.update(consentAnswers).set({ answer: "yes" }).where(eq(consentAnswers.formId, form.id)),
      ),
    ).rejects.toThrow();
    // The wording never changes once sent (the app's database role has no grant for it).
    await expect(
      withTenant(conn.app, { tenantId: s.tenant.id, userId: s.head.userId }, (tx) =>
        tx.update(consentForms).set({ body: "Something else" }).where(eq(consentForms.id, form.id)),
      ),
    ).rejects.toSatisfy(dbRefused(/permission denied/));

    // Exports: every answer, including the changed one.
    const { csv } = await exportDataset(conn.app, s.owner, "consent_answers");
    expect(csv.split("\n").filter((l) => l.includes("Museum trip"))).toHaveLength(3);
    expect((await exportDataset(conn.app, s.owner, "events")).csv).toContain("Museum trip");
  });

  it("are seen by teachers only for their classes, reminded at most daily, and close at the deadline", async () => {
    const s = await school();
    const today = todayIn(s.tenant.timezone);
    const a = await family(s, "Kofi", s.classA);
    const b = await family(s, "Kwame", s.classB);
    const teacher = await classTeacher(s, s.classA, "Basic 4A");
    const form = await createConsentForm(conn.app, s.head, {
      title: "Photos on the school website",
      body: "We would like to show your child in photos of school events on our website.",
      deadline: addDays(today, 3),
      audience: "school",
      audienceId: null,
    });
    const seen = (await getConsentForm(conn.app, teacher, form.id))!;
    expect(seen.children.map((c) => c.studentId)).toEqual([a.studentId]);
    expect(seen.canManage).toBe(false);
    await expect(remindConsentForm(conn.app, teacher, form.id, { sms: false })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await getConsentForm(conn.app, s.head, form.id))!.counts.children).toBe(2);

    // Told on creation: no reminder within a day; then only to families still waiting.
    await expect(remindConsentForm(conn.app, s.head, form.id, { sms: true })).rejects.toMatchObject({
      code: "consent_reminded",
    });
    await answerParentConsent(conn.app, a.phone, {
      slug: s.tenant.slug,
      formId: form.id,
      studentId: a.studentId,
      answer: "yes",
    });
    const later = new Date(Date.now() + 25 * 3_600_000);
    const sent = await remindConsentForm(conn.app, s.head, form.id, { sms: true }, later);
    expect(sent).toMatchObject({ families: 1, sms: 1 });
    expect((await outboxFor([a.phone, b.phone], "consent_request")).map((m) => m.recipient)).toEqual([
      b.phone,
    ]);

    // The deadline: it can move, but not into the past; after it, parents cannot answer.
    await expect(
      changeConsentDeadline(conn.app, s.head, form.id, { deadline: addDays(today, -1) }),
    ).rejects.toMatchObject({ code: "consent_deadline" });
    await asSchool(s, (tx) =>
      tx
        .update(consentForms)
        .set({ deadline: addDays(today, -1) })
        .where(eq(consentForms.id, form.id)),
    );
    await expect(
      answerParentConsent(conn.app, b.phone, {
        slug: s.tenant.slug,
        formId: form.id,
        studentId: b.studentId,
        answer: "no",
      }),
    ).rejects.toMatchObject({ code: "consent_closed" });
    expect(await listParentConsentForms(conn.app, b.phone)).toEqual([]);

    // Cancelled: no answers at all, even recorded on paper or written directly.
    await cancelConsentForm(conn.app, s.head, form.id);
    const guardianId = (await getConsentForm(conn.app, s.head, form.id))!.children.find(
      (c) => c.studentId === b.studentId,
    )!.guardians[0]!.id;
    await expect(
      recordPaperAnswer(conn.app, s.head, form.id, { studentId: b.studentId, guardianId, answer: "yes" }),
    ).rejects.toMatchObject({ code: "consent_cancelled" });
    await expect(
      asSchool(s, (tx) =>
        tx.insert(consentAnswers).values({
          tenantId: s.tenant.id,
          formId: form.id,
          studentId: b.studentId,
          guardianId,
          answer: "yes",
          source: "office",
          recordedByUserId: s.head.userId,
        }),
      ),
    ).rejects.toSatisfy(dbRefused(/cancelled/));
  });

  it("close with their event when it is cancelled", async () => {
    const s = await school();
    const today = todayIn(s.tenant.timezone);
    await family(s, "Yaa", s.classA);
    const event = await createEvent(conn.app, s.head, {
      title: "Swimming",
      startsOn: addDays(today, 4),
      audience: "level",
      audienceId: await levelOf(s),
    });
    const form = await createConsentForm(conn.app, s.head, {
      title: "Swimming lessons",
      body: "Lessons at the community pool.",
      deadline: addDays(today, 2),
      eventId: event.id,
      audience: "school",
      audienceId: null,
    });
    expect(await cancelEvent(conn.app, s.head, event.id)).toEqual({ forms: 1 });
    expect((await getConsentForm(conn.app, s.head, form.id))!).toMatchObject({
      cancelled: true,
      open: false,
    });
  });
});

async function levelOf(s: School) {
  const { classes } = await import("@/server/db/schema");
  const [row] = await asSchool(s, (tx) =>
    tx.select({ id: classes.levelId }).from(classes).where(eq(classes.id, s.classA)),
  );
  return row!.id;
}
