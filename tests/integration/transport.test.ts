import { randomBytes, randomInt } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { notificationOutbox, transportAssignments } from "@/server/db/schema";
import { exportDataset } from "@/server/export/datasets";
import { billTerm, getBillingStatus, getStudentAccount } from "@/server/fees/ledger";
import {
  createFeeItem,
  listStudentFeeOptions,
  setFeeItemDetails,
  setStudentFeeOption,
} from "@/server/fees/structure";
import { getParentChild } from "@/server/parents/portal";
import { savePushSubscription } from "@/server/parents/push";
import { createParentSession, validateParentSession } from "@/server/parents/sessions";
import { addGuardian } from "@/server/students/guardians";
import { assignStudent, endAssignment, listAssignments } from "@/server/transport/assignments";
import {
  getRoute,
  listRoutes,
  saveRoute,
  saveStop,
  saveVehicle,
  setFares,
  setNotifyFamilies,
  setRouteArchived,
  setTransportFeeItem,
} from "@/server/transport/setup";
import { getTrip, markBoarded, markLeft } from "@/server/transport/trips";
import { conn, school, type School } from "../support/mobile-money";

// Push needs a public key configured (web push, PSH-03).
beforeAll(() => {
  process.env.VAPID_PUBLIC_KEY = "BA" + randomBytes(60).toString("base64url");
});
afterAll(async () => {
  delete process.env.VAPID_PUBLIC_KEY;
  await conn.close();
});

/** A school with a bus, a route with two stops, a Transport fee item and fares, and three Basic 4 students. */
async function setup() {
  const s = await school();
  const kwame = (await s.add("Kwame", s.classA)).id;
  const esi = (await s.add("Esi", s.classA)).id;
  const ama = (await s.add("Ama", s.classA)).id;
  const bus = await saveVehicle(conn.app, s.owner, {
    name: "Bus 1",
    registration: "GT 1234-24",
    seats: "33",
    driverName: "Kwesi Appiah",
    driverPhone: "024 555 0177",
  });
  const route = await saveRoute(conn.app, s.owner, { name: "Tema Community 25", vehicleId: bus });
  const junction = await saveStop(conn.app, s.owner, route, {
    name: "Community 25 junction",
    morningTime: "06:40",
    afternoonTime: "15:50",
  });
  const barrier = await saveStop(conn.app, s.owner, route, { name: "Kpone barrier", morningTime: "06:55" });
  const item = await createFeeItem(conn.app, s.owner, { name: "Transport" });
  await setFeeItemDetails(conn.app, s.owner, item, { category: "transport", optional: true });
  return { s, kwame, esi, ama, bus, route, junction, barrier, item };
}

/** Rows a raw statement changes, as the application role (no service checks). */
const raw = (s: School, statement: ReturnType<typeof sql>) =>
  withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) => tx.execute(statement));

const transportLines = async (s: School, studentId: string) =>
  (await getStudentAccount(conn.app, s.bursar, studentId))!.entries
    .filter((e) => e.description.startsWith("Transport"))
    .map((e) => e.amountPesewas);

describe("transport routes and fares (TRN-01, TRN-02)", () => {
  it("sets up a route, puts students on stops, and bills each one their fare through the ledger", async () => {
    const { s, kwame, esi, ama, route, junction, barrier, item } = await setup();
    const detail = (await getRoute(conn.app, s.owner, route))!;
    expect(detail).toMatchObject({ vehicle: "Bus 1", stops: 2 });
    expect(detail.stopList.map((x) => [x.sequence, x.name, x.morningTime])).toEqual([
      [1, "Community 25 junction", "06:40"],
      [2, "Kpone barrier", "06:55"],
    ]);
    await expect(saveStop(conn.app, s.owner, route, { name: "Late", morningTime: "6.40" })).rejects.toThrow();
    await expect(saveRoute(conn.app, s.owner, { name: "tema community 25" })).rejects.toThrow(
      "already a route with this name",
    );

    // Fares and the fee item are fees: the Accountant sets them, the Head teacher cannot.
    await expect(setFares(conn.app, s.head, route, { fare: "450" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setTransportFeeItem(conn.app, s.head, item)).rejects.toBeInstanceOf(ForbiddenError);
    await setTransportFeeItem(conn.app, s.bursar, item);
    await setFares(conn.app, s.bursar, route, { fare: "450", [`stop:${barrier}`]: "300" });
    await expect(setFares(conn.app, s.bursar, route, { fare: "lots" })).rejects.toThrow("Enter an amount");

    // The office puts students on stops; teachers cannot.
    await expect(
      assignStudent(conn.app, s.teacher, { studentId: kwame, stopId: junction, direction: "both" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await assignStudent(conn.app, s.head, { studentId: kwame, stopId: junction, direction: "both" });
    await assignStudent(conn.app, s.head, { studentId: esi, stopId: barrier, direction: "to_school" });
    const { assignments } = await listAssignments(conn.app, s.bursar);
    expect(assignments.map((a) => [a.student, a.stop, a.direction, a.farePesewas])).toEqual([
      ["Kwame Mensah", "Community 25 junction", "both", 45000],
      ["Esi Mensah", "Kpone barrier", "to_school", 30000],
    ]);
    expect((await listRoutes(conn.app, s.owner))[0]!.riders).toBe(2);

    // While Transport decides who pays it, the item is not chosen on the student's fee page.
    expect((await listStudentFeeOptions(conn.app, s.bursar, ama)).map((o) => o.name)).not.toContain(
      "Transport",
    );
    await expect(
      setStudentFeeOption(conn.app, s.bursar, ama, { feeItemId: item, takes: true }),
    ).rejects.toThrow("charged from the student's route");

    // Billing the term charges each rider their fare, and nobody else.
    await billTerm(conn.app, s.bursar, s.termId);
    expect(await transportLines(s, kwame)).toEqual([45000]);
    expect(await transportLines(s, esi)).toEqual([30000]);
    expect(await transportLines(s, ama)).toEqual([]);

    // A move after billing never changes a charge: it shows as a difference for the Accountant.
    await assignStudent(conn.app, s.head, { studentId: kwame, stopId: barrier, direction: "both" });
    const status = (await getBillingStatus(conn.app, s.bursar, s.termId))!;
    expect(status.differences).toEqual([
      expect.objectContaining({
        studentName: "Kwame Mensah",
        itemName: "Transport",
        billedPesewas: 45000,
        structurePesewas: 30000,
      }),
    ]);
    expect(await transportLines(s, kwame)).toEqual([45000]);
    // The old assignment is kept as ended.
    const history = await withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      tx
        .select({ stopId: transportAssignments.stopId, endedAt: transportAssignments.endedAt })
        .from(transportAssignments)
        .where(
          and(eq(transportAssignments.tenantId, s.tenant.id), eq(transportAssignments.studentId, kwame)),
        ),
    );
    expect(history.map((h) => [h.stopId, h.endedAt !== null]).sort()).toEqual(
      [
        [junction, true],
        [barrier, false],
      ].sort(),
    );

    // A route with riders cannot be archived; history cannot be rewritten in the database.
    await expect(setRouteArchived(conn.app, s.owner, route, true)).rejects.toThrow("Move them first.");
    await expect(
      raw(s, sql`update transport_assignments set stop_id = ${junction} where student_id = ${kwame}`),
    ).rejects.toThrow();
    await expect(
      raw(s, sql`delete from transport_assignments where student_id = ${kwame}`),
    ).rejects.toThrow();
    await expect(raw(s, sql`delete from transport_routes where id = ${route}`)).rejects.toThrow();

    const file = await exportDataset(conn.app, s.owner, "transport");
    expect(file.rows).toBe(3);
    // Another school sees none of it.
    const other = await school();
    expect(await listRoutes(conn.app, other.owner)).toEqual([]);
    const { assignments: left } = await listAssignments(conn.app, s.owner);
    await endAssignment(conn.app, s.owner, left.find((a) => a.studentId === esi)!.id);
    await expect(endAssignment(conn.app, s.owner, left.find((a) => a.studentId === esi)!.id)).rejects.toThrow(
      "no longer on that route",
    );
  });
});

describe("trips (TRN-03)", () => {
  it("marks children on and off once, tells families by push, and shows it in the parent view", async () => {
    const { s, kwame, esi, ama, route, junction, barrier } = await setup();
    await assignStudent(conn.app, s.owner, { studentId: kwame, stopId: junction, direction: "both" });
    await assignStudent(conn.app, s.owner, { studentId: esi, stopId: barrier, direction: "to_school" });
    const phone = `+23324${randomInt(1000000, 9999999)}`;
    await addGuardian(conn.app, s.owner, kwame, {
      fullName: "Grace Mensah",
      phone,
      relationship: "mother",
      isPrimary: true,
    });
    const { token } = await createParentSession(conn.app, phone);
    await savePushSubscription(conn.app, (await validateParentSession(conn.app, token))!, {
      endpoint: `https://push.example.test/send/${randomBytes(12).toString("hex")}`,
      keys: {
        p256dh: "B" + randomBytes(64).toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    });

    // The teacher on the bus sees who rides each way.
    const morning = await getTrip(conn.app, s.teacher, route, "to_school");
    expect(morning.riders.map((r) => [r.name, r.stop, r.time, r.state])).toEqual([
      ["Kwame Mensah", "Community 25 junction", "06:40", "waiting"],
      ["Esi Mensah", "Kpone barrier", "06:55", "waiting"],
    ]);
    expect((await getTrip(conn.app, s.teacher, route, "from_school")).riders.map((r) => r.name)).toEqual([
      "Kwame Mensah",
    ]);
    await expect(getTrip(conn.app, s.bursar, route, "to_school")).rejects.toBeInstanceOf(ForbiddenError);

    await expect(markLeft(conn.app, s.teacher, route, "to_school", kwame)).rejects.toThrow(
      "on the bus first",
    );
    await expect(markBoarded(conn.app, s.teacher, route, "to_school", ama)).rejects.toThrow("does not ride");
    await expect(markBoarded(conn.app, s.teacher, route, "from_school", esi)).rejects.toThrow(
      "does not ride",
    );
    await markBoarded(conn.app, s.teacher, route, "to_school", kwame);
    await expect(markBoarded(conn.app, s.teacher, route, "to_school", kwame)).rejects.toThrow(
      "Already marked",
    );
    await markLeft(conn.app, s.teacher, route, "to_school", kwame);
    await expect(markLeft(conn.app, s.teacher, route, "to_school", kwame)).rejects.toThrow("already off");
    expect((await getTrip(conn.app, s.teacher, route, "to_school")).riders[0]).toMatchObject({
      state: "off",
    });

    // One push for getting on and one for getting off; nothing private in it.
    const pushes = await conn.owner
      .select({ payload: notificationOutbox.payload })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.template, "transport_push"),
          sql`${notificationOutbox.payload}->>'studentId' = ${kwame}`,
        ),
      );
    expect(pushes).toHaveLength(2);

    // The parent view shows the route, stop and today's times.
    const child = (await getParentChild(conn.app, phone, s.tenant.slug, kwame))!;
    expect(child.transport).toMatchObject({
      route: "Tema Community 25",
      stop: "Community 25 junction",
      ride: "both",
    });
    expect(child.transport!.today).toEqual([
      expect.objectContaining({ direction: "to_school", leftAt: expect.any(Date) }),
    ]);

    // With notifications off, the afternoon run tells nobody.
    await setNotifyFamilies(conn.app, s.owner, false);
    await markBoarded(conn.app, s.teacher, route, "from_school", kwame);
    const after = await conn.owner
      .select({ id: notificationOutbox.id })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.template, "transport_push"),
          sql`${notificationOutbox.payload}->>'studentId' = ${kwame}`,
        ),
      );
    expect(after).toHaveLength(2);

    // Marks are kept as made.
    await expect(
      raw(s, sql`update transport_trip_marks set boarded_at = now() where student_id = ${kwame}`),
    ).rejects.toThrow();
    await expect(raw(s, sql`delete from transport_trip_marks where student_id = ${kwame}`)).rejects.toThrow();
    const file = await exportDataset(conn.app, s.owner, "transport_trips");
    expect(file.rows).toBe(2);
  });
});
