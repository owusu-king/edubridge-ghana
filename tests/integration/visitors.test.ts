import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { auditEvents, campuses, membershipCampuses, pickups, visitorVisits } from "@/server/db/schema";
import { exportDataset } from "@/server/export/datasets";
import { addGuardian } from "@/server/students/guardians";
import { setGuardianFlags } from "@/server/students/profile";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import {
  addCollector,
  cancelPickup,
  endCollector,
  getCollectorPhoto,
  getPickupDay,
  getStudentPickup,
  listPickupClasses,
  listRefusalsToday,
  refusePickup,
  releaseStudent,
} from "@/server/visitors/pickup";
import {
  listOnSite,
  listVisitorOptions,
  listVisitsOn,
  signInVisitor,
  signOutVisitor,
} from "@/server/visitors/visits";
import { todayIn } from "@/lib/format";
import { addMember, createUser } from "../support/fixtures";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("synthetic"),
]);

/** An Administrator limited to the East campus. */
async function eastAdmin(s: School): Promise<TenantContext> {
  const user = await createUser(conn.owner, "East Office");
  const m = await addMember(conn.owner, s.tenant.id, user.id, ["admin"]);
  await withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, async (tx) => {
    const [east] = await tx
      .select({ id: campuses.id })
      .from(campuses)
      .where(and(eq(campuses.tenantId, s.tenant.id), eq(campuses.name, "East")));
    await tx
      .insert(membershipCampuses)
      .values({ tenantId: s.tenant.id, membershipId: m.id, campusId: east!.id });
  });
  return (await resolveTenantContext(conn.app, s.tenant.slug, user.id)) as TenantContext;
}

/** Runs raw SQL as the application role, bypassing every service check. */
const raw = (s: School, statement: ReturnType<typeof sql>) =>
  withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) => tx.execute(statement));

describe("visitors (VIS-01)", () => {
  it("signs visitors in and out once, by campus, and keeps every visit", async () => {
    const s = await school();
    const east = await eastAdmin(s);
    const options = await listVisitorOptions(conn.app, s.owner);
    expect(options.campuses.map((c) => c.name)).toEqual(["East", "Main"]);
    const main = options.campuses.find((c) => c.name === "Main")!.id;
    const head = options.hosts.find((h) => h.name === "Head")!.id;

    // Two campuses: the campus is needed. A phone in the school's national form is stored in full.
    await expect(
      signInVisitor(conn.app, s.owner, { fullName: "Yaw Boakye", purpose: "meeting" }),
    ).rejects.toThrow("Choose the campus.");
    await expect(
      signInVisitor(conn.app, s.owner, { fullName: "Yaw Boakye", purpose: "lunch", campusId: main }),
    ).rejects.toThrow();
    const id = await signInVisitor(conn.app, s.owner, {
      fullName: "Yaw Boakye",
      phone: "024 123 4567",
      organisation: "Ghana Education Service",
      purpose: "official",
      hostMembershipId: head,
      hostName: "ignored when a member is chosen",
      campusId: main,
      badge: "V12",
    });
    // A member limited to East signs in at East without choosing.
    await signInVisitor(conn.app, east, { fullName: "Ama Delivery", purpose: "delivery" });

    const onSite = await listOnSite(conn.app, s.owner);
    expect(onSite.map((v) => v.fullName).sort()).toEqual(["Ama Delivery", "Yaw Boakye"]);
    expect(onSite.find((v) => v.id === id)).toMatchObject({
      phone: "+233241234567",
      visiting: "Head",
      campus: "Main",
      signedOutAt: null,
    });
    // Campus scope: East sees only East, and cannot sign out a Main visitor.
    expect((await listOnSite(conn.app, east)).map((v) => v.fullName)).toEqual(["Ama Delivery"]);
    await expect(signOutVisitor(conn.app, east, id)).rejects.toThrow("Visit not found.");
    await expect(listOnSite(conn.app, s.teacher)).rejects.toBeInstanceOf(ForbiddenError);

    await signOutVisitor(conn.app, s.head, id);
    await expect(signOutVisitor(conn.app, s.owner, id)).rejects.toThrow("already been signed out");
    expect((await listOnSite(conn.app, s.owner)).map((v) => v.fullName)).toEqual(["Ama Delivery"]);
    const today = todayIn(s.owner.tenant.timezone);
    const [logged] = (await listVisitsOn(conn.app, s.owner, today)).filter((v) => v.id === id);
    expect(logged).toMatchObject({ signedOutBy: "Head", signedInBy: "Proprietor" });
    expect(await listVisitsOn(conn.app, s.owner, "2020-01-01")).toEqual([]);

    // The database keeps the visit as it was: no edits, no second sign-out, no deletes.
    await expect(
      raw(s, sql`update visitor_visits set full_name = 'Someone else' where id = ${id}`),
    ).rejects.toThrow();
    await expect(
      raw(s, sql`update visitor_visits set signed_out_at = now() where id = ${id}`),
    ).rejects.toThrow();
    await expect(raw(s, sql`delete from visitor_visits where id = ${id}`)).rejects.toThrow();
    // Another school sees none of it.
    const other = await school();
    const seen = await withTenant(conn.app, { tenantId: other.tenant.id, userId: other.owner.userId }, (tx) =>
      tx.select({ id: visitorVisits.id }).from(visitorVisits),
    );
    expect(seen).toEqual([]);

    const file = await exportDataset(conn.app, s.owner, "visitors");
    expect(file.rows).toBe(2);
    expect(file.csv).toContain("Ghana Education Service");
  });
});

describe("pickup (VIS-02)", () => {
  async function setup() {
    const s = await school();
    const kwame = (await s.add("Kwame", s.classA)).id;
    const esi = (await s.add("Esi", s.classA)).id;
    const kojo = (await s.add("Kojo", s.classB)).id;
    const { guardianId } = await addGuardian(conn.app, s.owner, kwame, {
      fullName: "Grace Mensah",
      phone: "024 555 0122",
      relationship: "mother",
      isPrimary: true,
    });
    return { s, kwame, esi, kojo, mother: guardianId };
  }

  it("releases a child only to someone allowed at that moment, and records refusals", async () => {
    const { s, kwame, esi, mother } = await setup();
    const today = todayIn(s.owner.tenant.timezone);

    // Not yet allowed: the guardian's flag is off on the student record.
    await expect(
      releaseStudent(conn.app, s.teacher, kwame, { collector: `guardian:${mother}` }),
    ).rejects.toThrow("may not collect the child");
    await setGuardianFlags(conn.app, s.owner, kwame, mother, {
      isFeePayer: true,
      isEmergencyContact: true,
      canPickUp: true,
      receivesMessages: true,
    });

    // A named collector with a photo, for Esi; one for a single day that has passed is refused.
    const uncle = await addCollector(
      conn.app,
      s.owner,
      esi,
      { fullName: "Kofi Quaye", relationship: "Uncle", phone: "020 555 0199", validUntil: today },
      { filename: "kofi.png", bytes: PNG },
    );
    await expect(
      addCollector(conn.app, s.owner, esi, {
        fullName: "Old Driver",
        relationship: "Driver",
        validUntil: "2020-01-01",
      }),
    ).rejects.toThrow("Choose today or a later day.");
    await expect(
      addCollector(conn.app, s.teacher, esi, { fullName: "Someone", relationship: "Aunt" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getCollectorPhoto(conn.app, s.teacher, esi, uncle))?.mime).toBe("image/png");
    // The collector belongs to Esi only.
    await expect(
      releaseStudent(conn.app, s.teacher, kwame, { collector: `collector:${uncle}` }),
    ).rejects.toThrow("may not collect the child");

    // The teacher (not the class teacher) on gate duty sees the class with who may collect each child.
    const { classes } = await listPickupClasses(conn.app, s.teacher);
    expect(classes.map((c) => c.name)).toEqual(["Basic 4A", "Basic 4B"]);
    let day = await getPickupDay(conn.app, s.teacher, s.classA);
    expect(day.students.map((d) => [d.name, d.collectors.map((c) => c.name)])).toEqual([
      ["Esi Mensah", ["Kofi Quaye"]],
      ["Kwame Mensah", ["Grace Mensah"]],
    ]);

    expect(await releaseStudent(conn.app, s.teacher, kwame, { collector: `guardian:${mother}` })).toEqual({
      personName: "Grace Mensah",
    });
    await refusePickup(conn.app, s.teacher, esi, {
      personName: "Unknown Man",
      relationship: "Said he was a neighbour",
      reason: "Not on her list.",
    });
    await expect(refusePickup(conn.app, s.teacher, esi, { personName: "X", reason: "" })).rejects.toThrow();
    day = await getPickupDay(conn.app, s.teacher, s.classA);
    expect(day.students.map((d) => [d.name, d.latest?.outcome ?? null])).toEqual([
      ["Esi Mensah", "refused"],
      ["Kwame Mensah", "released"],
    ]);
    expect(day.refusals.map((r) => r.personName)).toEqual(["Unknown Man"]);
    expect((await listRefusalsToday(conn.app, s.head)).map((r) => [r.student, r.className])).toEqual([
      ["Esi Mensah", "Basic 4A"],
    ]);

    // Then the uncle comes: released to him. Ending him stops the next release.
    await releaseStudent(conn.app, s.teacher, esi, { collector: `collector:${uncle}` });
    await endCollector(conn.app, s.owner, uncle, "Family asked to stop.");
    await expect(endCollector(conn.app, s.owner, uncle, "Again")).rejects.toThrow("already been ended");
    await expect(
      releaseStudent(conn.app, s.teacher, esi, { collector: `collector:${uncle}` }),
    ).rejects.toThrow("may not collect the child");
    const esiPickup = await getStudentPickup(conn.app, s.owner, esi);
    expect(esiPickup.collectors).toEqual([
      expect.objectContaining({ fullName: "Kofi Quaye", phone: "+233205550199", allowed: false }),
    ]);
    expect(esiPickup.history.map((r) => r.outcome)).toEqual(["released", "refused"]);
    // Phone numbers are for the office only.
    expect((await getStudentPickup(conn.app, s.teacher, esi)).collectors[0]!.phone).toBeNull();
    expect(esiPickup.student.name).toBe("Esi Mensah");

    // Changes to collectors are audited without names or numbers.
    const audit = await withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      tx
        .select({ action: auditEvents.action, metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, s.tenant.id), eq(auditEvents.entityId, esi))),
    );
    expect(audit.map((a) => a.action).filter((a) => a.startsWith("pickup."))).toEqual([
      "pickup.collector_added",
      "pickup.collector_ended",
    ]);
    expect(JSON.stringify(audit)).not.toContain("Kofi");
  });

  it("cancels a mistaken record once, keeps it, and keeps the database history unchanged", async () => {
    const { s, kwame, mother } = await setup();
    await setGuardianFlags(conn.app, s.owner, kwame, mother, {
      isFeePayer: true,
      isEmergencyContact: false,
      canPickUp: true,
      receivesMessages: true,
    });
    await releaseStudent(conn.app, s.teacher, kwame, { collector: `guardian:${mother}` });
    const [record] = (await getStudentPickup(conn.app, s.teacher, kwame)).history;
    await expect(cancelPickup(conn.app, s.teacher, record!.id, "")).rejects.toThrow(
      "Say why it is cancelled.",
    );
    await cancelPickup(conn.app, s.teacher, record!.id, "Wrong child chosen.");
    await expect(cancelPickup(conn.app, s.teacher, record!.id, "Again please")).rejects.toThrow(
      "already been cancelled",
    );
    const day = await getPickupDay(conn.app, s.teacher, s.classA);
    expect(day.students.find((d) => d.id === kwame)?.latest).toBeNull();
    expect((await getStudentPickup(conn.app, s.teacher, kwame)).history[0]).toMatchObject({
      cancelReason: "Wrong child chosen.",
    });

    await expect(
      raw(s, sql`update pickups set person_name = 'Someone else' where id = ${record!.id}`),
    ).rejects.toThrow();
    await expect(raw(s, sql`delete from pickups where id = ${record!.id}`)).rejects.toThrow();
    // A release must name exactly one allowed person; a refusal must say why (database).
    await expect(
      raw(
        s,
        sql`insert into pickups (tenant_id, student_id, on_date, outcome, person_name, recorded_by_user_id)
            values (${s.tenant.id}, ${kwame}, current_date, 'released', 'Nobody', ${s.owner.userId})`,
      ),
    ).rejects.toThrow();
    const rows = await withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      tx.select({ id: pickups.id }).from(pickups).where(eq(pickups.tenantId, s.tenant.id)),
    );
    expect(rows).toHaveLength(1);
    const file = await exportDataset(conn.app, s.owner, "pickups");
    expect(file.csv).toContain("Wrong child chosen.");
  });

  it("limits staff to children at their campuses", async () => {
    const { s, kwame, kojo } = await setup();
    const east = await eastAdmin(s);
    expect((await listPickupClasses(conn.app, east)).classes.map((c) => c.name)).toEqual(["Basic 4B"]);
    await expect(getPickupDay(conn.app, east, s.classA)).rejects.toThrow("Class not found.");
    await expect(getStudentPickup(conn.app, east, kwame)).rejects.toThrow("Student not found.");
    await expect(
      refusePickup(conn.app, east, kwame, { personName: "Someone", reason: "Not known" }),
    ).rejects.toThrow("Student not found.");
    await addCollector(conn.app, east, kojo, { fullName: "Ama Addo", relationship: "Aunt" });
    expect((await getStudentPickup(conn.app, east, kojo)).collectors.map((c) => c.fullName)).toEqual([
      "Ama Addo",
    ]);
    await expect(getPickupDay(conn.app, s.bursar, s.classB)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
