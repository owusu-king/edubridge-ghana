import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { listLevelsWithClasses } from "@/server/academics/classes";
import { ForbiddenError } from "@/server/authz/permissions";
import {
  endPlacement,
  listBoarders,
  listExeats,
  placeBoarder,
  readParentBoarding,
  signInBoarder,
  signOutBoarder,
} from "@/server/boarding/boarders";
import {
  addBeds,
  addRoom,
  appointHouseStaff,
  endHouseStaff,
  getHouse,
  listHouses,
  listStaffOptions,
  saveHouse,
  setBoardingFeeItem,
  setHouseArchived,
} from "@/server/boarding/houses";
import { withTenant } from "@/server/db/context";
import { boardingExeats } from "@/server/db/schema";
import { exportDataset } from "@/server/export/datasets";
import { billTerm, getBillingStatus, getStudentAccount } from "@/server/fees/ledger";
import {
  createFeeItem,
  listFeeItems,
  listStudentFeeOptions,
  saveLevelFees,
  setFeeItemDetails,
} from "@/server/fees/structure";
import { createStudent } from "@/server/students/service";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const raw = (s: School, statement: ReturnType<typeof sql>) =>
  withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) => tx.execute(statement));

const fresh = async (s: School, ctx: TenantContext) =>
  (await resolveTenantContext(conn.app, s.tenant.slug, ctx.userId)) as TenantContext;

const bedsOf = async (s: School, houseId: string) =>
  (await getHouse(conn.app, s.owner, houseId))!.rooms.flatMap((r) => r.beds);

async function setup() {
  const s = await school();
  const kofi = (
    await createStudent(conn.app, s.owner, {
      firstName: "Kofi",
      lastName: "Mensah",
      sex: "male",
      classId: s.classA,
    })
  ).id;
  const yaw = (
    await createStudent(conn.app, s.owner, {
      firstName: "Yaw",
      lastName: "Mensah",
      sex: "male",
      classId: s.classA,
    })
  ).id;
  const akua = (await s.add("Akua", s.classA)).id; // female
  const boys = await saveHouse(conn.app, s.owner, { name: "Aggrey House", kind: "boys" });
  const girls = await saveHouse(conn.app, s.owner, { name: "Yaa Asantewaa House", kind: "girls" });
  await addRoom(conn.app, s.owner, boys, { name: "Dormitory A", beds: "2" });
  await addRoom(conn.app, s.owner, girls, { name: "Dormitory B", beds: "2" });
  return { s, kofi, yaw, akua, boys, girls };
}

describe("houses and boarders (BRD-01)", () => {
  it("numbers beds, places each boarder in one bed and each bed for one boarder, and keeps moves", async () => {
    const { s, kofi, yaw, akua, boys, girls } = await setup();
    await expect(addRoom(conn.app, s.owner, boys, { name: "Dormitory A", beds: "1" })).rejects.toThrow(
      "already has a room with this name",
    );
    const room = (await getHouse(conn.app, s.owner, boys))!.rooms[0]!;
    await addBeds(conn.app, s.owner, room.id, "1");
    const [bed1, bed2, bed3] = await bedsOf(s, boys);
    expect([bed1, bed2, bed3].map((b) => b!.label)).toEqual(["Bed 1", "Bed 2", "Bed 3"]);
    const [girlsBed] = await bedsOf(s, girls);

    // A girl is not placed in a boys' house; teachers cannot place anyone.
    await expect(placeBoarder(conn.app, s.owner, { studentId: akua, bedId: bed1!.id })).rejects.toThrow(
      "Aggrey House is a boys' house.",
    );
    await expect(
      placeBoarder(conn.app, s.teacher, { studentId: kofi, bedId: bed1!.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await placeBoarder(conn.app, s.owner, { studentId: kofi, bedId: bed1!.id });
    await placeBoarder(conn.app, s.owner, { studentId: akua, bedId: girlsBed!.id });
    await expect(placeBoarder(conn.app, s.owner, { studentId: yaw, bedId: bed1!.id })).rejects.toThrow(
      "Someone already sleeps in this bed",
    );
    // Moving ends the old bed and keeps it.
    await placeBoarder(conn.app, s.owner, { studentId: kofi, bedId: bed2!.id });
    await placeBoarder(conn.app, s.owner, { studentId: yaw, bedId: bed1!.id });
    const house = (await getHouse(conn.app, s.head, boys))!;
    expect(house.rooms[0]!.beds.map((b) => [b.label, b.boarder?.name ?? null])).toEqual([
      ["Bed 1", "Yaw Mensah"],
      ["Bed 2", "Kofi Mensah"],
      ["Bed 3", null],
    ]);
    expect(house).toMatchObject({ boarders: 2, beds: 3 });
    await expect(setHouseArchived(conn.app, s.owner, boys, true)).rejects.toThrow("Move them first.");

    // The database keeps one open bed per boarder and one boarder per bed, and never deletes either.
    await expect(
      raw(
        s,
        sql`insert into boarding_assignments (tenant_id, student_id, term_id, bed_id, created_by_user_id)
            select tenant_id, ${akua}, term_id, bed_id, created_by_user_id from boarding_assignments
            where student_id = ${yaw} and ended_at is null`,
      ),
    ).rejects.toThrow();
    await expect(raw(s, sql`delete from boarding_assignments`)).rejects.toThrow();
    await expect(raw(s, sql`delete from boarding_beds`)).rejects.toThrow();
    expect((await exportDataset(conn.app, s.owner, "boarding")).rows).toBe(4);
    const other = await school();
    expect(await listHouses(conn.app, other.owner)).toEqual([]);
  });
});

describe("boarding fees (BRD-02)", () => {
  it("charges the boarding item at the structure's amount to boarders only", async () => {
    const { s, kofi, yaw, boys } = await setup();
    const boarding = await createFeeItem(conn.app, s.owner, { name: "Boarding" });
    await setFeeItemDetails(conn.app, s.owner, boarding, { category: "boarding", optional: true });
    const basic4 = (await listLevelsWithClasses(conn.app, s.owner)).find((l) => l.name === "Basic 4")!;
    const tuition = (await listFeeItems(conn.app, s.bursar)).find((i) => i.name === "Tuition")!;
    await saveLevelFees(conn.app, s.bursar, s.termId, basic4.id, {
      amounts: { [tuition.id]: "1000", [boarding]: "2500" },
      classAmounts: {},
    });
    await expect(setBoardingFeeItem(conn.app, s.head, boarding)).rejects.toBeInstanceOf(ForbiddenError);
    await setBoardingFeeItem(conn.app, s.bursar, boarding);
    const [bed] = await bedsOf(s, boys);
    await placeBoarder(conn.app, s.owner, { studentId: kofi, bedId: bed!.id });
    expect((await listStudentFeeOptions(conn.app, s.bursar, yaw)).map((o) => o.name)).not.toContain(
      "Boarding",
    );

    await billTerm(conn.app, s.bursar, s.termId);
    const lines = async (id: string) =>
      (await getStudentAccount(conn.app, s.bursar, id))!.entries
        .filter((e) => e.description.startsWith("Boarding"))
        .map((e) => e.amountPesewas);
    expect(await lines(kofi)).toEqual([250000]);
    expect(await lines(yaw)).toEqual([]);

    // Leaving boarding after billing never changes the charge: it shows as a difference.
    const assignment = (await getHouse(conn.app, s.owner, boys))!.rooms[0]!.beds[0]!.boarder!.assignmentId;
    await endPlacement(conn.app, s.owner, assignment);
    expect((await getBillingStatus(conn.app, s.bursar, s.termId))!.differences).toEqual([
      expect.objectContaining({
        studentName: "Kofi Mensah",
        itemName: "Boarding",
        billedPesewas: 250000,
        structurePesewas: 0,
      }),
    ]);
  });
});

describe("house staff and exeats (BRD-01b, BRD-03)", () => {
  it("lets house staff see their own house only, and sign its boarders out and back in once", async () => {
    const { s, kofi, akua, boys, girls } = await setup();
    const [boysBed] = await bedsOf(s, boys);
    const [girlsBed] = await bedsOf(s, girls);
    await placeBoarder(conn.app, s.owner, { studentId: kofi, bedId: boysBed!.id });
    await placeBoarder(conn.app, s.owner, { studentId: akua, bedId: girlsBed!.id });

    // The teacher becomes Aggrey House's housemaster: a school grant, not a role.
    expect(await listBoarders(conn.app, s.teacher).catch((e: unknown) => e)).toBeInstanceOf(ForbiddenError);
    const teacherMembership = (await listStaffOptions(conn.app, s.owner)).find(
      (m) => m.name === "Teacher",
    )!.id;
    await appointHouseStaff(conn.app, s.owner, boys, teacherMembership);
    const housemaster = await fresh(s, s.teacher);
    expect((await listHouses(conn.app, housemaster)).map((h) => h.name)).toEqual(["Aggrey House"]);
    expect((await listBoarders(conn.app, housemaster)).map((b) => b.name)).toEqual(["Kofi Mensah"]);
    expect(await getHouse(conn.app, housemaster, girls)).toBeNull();

    await expect(
      signOutBoarder(conn.app, housemaster, {
        studentId: akua,
        reason: "Family wedding",
        collectedBy: "Grace Mensah, mother",
        expectedBackOn: "2099-01-01",
      }),
    ).rejects.toThrow("Choose a boarder in your house.");
    await expect(
      signOutBoarder(conn.app, housemaster, {
        studentId: kofi,
        reason: "Family wedding",
        collectedBy: "Grace Mensah, mother",
        expectedBackOn: "2020-01-01",
      }),
    ).rejects.toThrow("Choose today or a later day.");
    const exeat = {
      studentId: kofi,
      reason: "Family wedding",
      collectedBy: "Grace Mensah, mother",
      expectedBackOn: "2099-01-01",
    };
    await signOutBoarder(conn.app, housemaster, exeat);
    await expect(signOutBoarder(conn.app, housemaster, exeat)).rejects.toThrow("already out on exeat");

    let { out } = await listExeats(conn.app, s.bursar);
    expect(out).toEqual([expect.objectContaining({ student: "Kofi Mensah", overdueDays: 0 })]);
    await signInBoarder(conn.app, housemaster, out[0]!.id);
    await expect(signInBoarder(conn.app, housemaster, out[0]!.id)).rejects.toThrow("already back");
    await expect(raw(s, sql`update boarding_exeats set back_at = now()`)).rejects.toThrow();
    await expect(raw(s, sql`delete from boarding_exeats`)).rejects.toThrow();

    // An exeat that was due back two days ago (written as if time had passed) shows as overdue.
    await withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      tx.insert(boardingExeats).values({
        tenantId: s.tenant.id,
        studentId: kofi,
        houseId: boys,
        reason: "Hospital visit",
        collectedBy: "Grace Mensah, mother",
        expectedBackOn: sql`current_date - 2`,
        outAt: sql`now() - interval '4 days'`,
        outByUserId: s.teacher.userId,
      }),
    );
    ({ out } = await listExeats(conn.app, s.bursar));
    expect(out).toEqual([expect.objectContaining({ student: "Kofi Mensah", overdueDays: 2 })]);

    // The parent view shows the house and the exeat.
    await withTenant(conn.app, { tenantId: s.tenant.id, userId: "" }, async (tx) => {
      expect(await readParentBoarding(tx, s.tenant.id, kofi)).toMatchObject({
        house: "Aggrey House",
        room: "Dormitory A",
        bed: "Bed 1",
        exeat: expect.objectContaining({ outAt: expect.any(Date) }),
      });
    });
    await signInBoarder(conn.app, housemaster, out[0]!.id);
    expect((await exportDataset(conn.app, s.owner, "exeats")).rows).toBe(2);

    // Ending the appointment takes the access away at once.
    const staff = (await getHouse(conn.app, s.owner, boys))!.staffList[0]!;
    await endHouseStaff(conn.app, s.owner, staff.id);
    await expect(listBoarders(conn.app, await fresh(s, s.teacher))).rejects.toBeInstanceOf(ForbiddenError);
  });
});
