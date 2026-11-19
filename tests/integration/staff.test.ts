import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { allowed, ForbiddenError } from "@/server/authz/permissions";
import { updateClass } from "@/server/academics/classes";
import { withTenant } from "@/server/db/context";
import {
  auditEvents,
  classes,
  leaveRequests,
  membershipCampuses,
  memberships,
  staffEmploymentEvents,
} from "@/server/db/schema";
import { grantModule } from "@/server/entitlements/admin";
import { getStaffDay, saveStaffDay } from "@/server/staff/attendance";
import {
  addSuggestedLeaveTypes,
  cancelLeave,
  decideLeave,
  getLeaveOverview,
  getMyLeave,
  getStaffLeave,
  listLeaveTypes,
  requestLeave,
} from "@/server/staff/leave";
import {
  addStaffListItem,
  changeEmployment,
  createStaff,
  downloadStaffDocument,
  getStaff,
  linkStaffMember,
  listStaff,
  updateStaffDetails,
  uploadStaffDocument,
} from "@/server/staff/records";
import { updateEntitlements } from "@/server/platform/service";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { todayIn } from "@/lib/format";
import { DEFAULT_PLAN_FEATURES } from "@/lib/plan";
import { addMember, createUser, makePlatformAdmin } from "../support/fixtures";
import { conn, school as baseSchool, type School } from "../support/mobile-money";

afterAll(() => conn.close());

const PDF = Buffer.from("%PDF-1.4\n% synthetic staff contract\n");

const platform = (async () => {
  const user = await createUser(conn.owner, "EduBridge Staff");
  await makePlatformAdmin(conn.owner, user.id);
  return user;
})();

const membershipOf = async (s: School, userId: string) => {
  const [m] = await withTenant(conn.owner, { tenantId: s.tenant.id, userId }, (tx) =>
    tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.tenantId, s.tenant.id), eq(memberships.userId, userId))),
  );
  return m!.id;
};

/** A fixture class's level and campus (Basic 4A is at Main, Basic 4B at East). */
const classOf = async (s: School, classId: string) => {
  const [c] = await withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
    tx.select().from(classes).where(eq(classes.id, classId)),
  );
  return c!;
};

const person = (s: School, extra: Record<string, unknown> = {}) =>
  createStaff(conn.app, s.owner, {
    firstName: "Abena",
    lastName: "Owusu",
    phone: "024 455 6677",
    employmentType: "permanent",
    startedOn: "2025-09-01",
    ...extra,
  });

const auditFor = (s: School, entityId: string) =>
  withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
    tx
      .select({ action: auditEvents.action, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(and(eq(auditEvents.tenantId, s.tenant.id), eq(auditEvents.entityId, entityId))),
  );

describe("staff records (HR-01, HR-02)", () => {
  it("keeps people with or without an account, numbered, with their employment history", async () => {
    const s = await baseSchool();
    const teaching = await addStaffListItem(conn.app, s.owner, "department", { name: "Teaching" });
    const role = await addStaffListItem(conn.app, s.owner, "position", { name: "Class teacher" });
    await expect(
      addStaffListItem(conn.app, s.owner, "position", { name: "class teacher" }),
    ).rejects.toMatchObject({
      code: "name_taken",
    });
    const abena = await person(s, {
      departmentId: teaching,
      positionId: role,
      campusId: (await classOf(s, s.classA)).campusId,
    });
    const kofi = await person(s, { firstName: "Kofi", lastName: "Mensah", employmentType: "casual" });
    const list = await listStaff(conn.app, s.head);
    expect(list.map((p) => [p.staffNumber, p.name, p.position])).toEqual([
      ["S0002", "Kofi Mensah", null],
      ["S0001", "Abena Owusu", "Class teacher"],
    ]);
    expect(list[1]).toMatchObject({ phone: "+233244556677", hasAccount: false });

    // Personal details are corrected in place; the audit log names the fields, not the values.
    await updateStaffDetails(conn.app, s.owner, kofi, {
      firstName: "Kofi",
      lastName: "Mensah",
      phone: "055 111 2222",
    });
    const audit = await auditFor(s, kofi);
    expect(audit.find((a) => a.action === "staff.details_updated")?.metadata).toEqual({ fields: ["phone"] });

    // Employment changes are events with dates; leaving needs a reason; returning restores the record.
    await changeEmployment(conn.app, s.owner, abena, {
      kind: "changed",
      effectiveOn: "2026-01-05",
      employmentType: "contract",
      departmentId: teaching,
      positionId: role,
    });
    await expect(
      changeEmployment(conn.app, s.owner, abena, {
        kind: "left",
        effectiveOn: "2026-07-31",
        employmentType: "contract",
      }),
    ).rejects.toMatchObject({ code: "reason_required" });
    await changeEmployment(conn.app, s.owner, abena, {
      kind: "left",
      effectiveOn: "2026-07-31",
      employmentType: "contract",
      note: "Moved to another town",
    });
    expect((await listStaff(conn.app, s.owner)).map((p) => p.name)).toEqual(["Kofi Mensah"]);
    await changeEmployment(conn.app, s.owner, abena, {
      kind: "returned",
      effectiveOn: "2026-09-08",
      employmentType: "part_time",
    });
    const detail = await getStaff(conn.app, s.owner, abena);
    expect(detail.record).toMatchObject({ status: "active", employmentType: "part_time", leftOn: null });
    expect(detail.history.map((h) => [h.kind, h.effectiveOn])).toEqual([
      ["returned", "2026-09-08"],
      ["left", "2026-07-31"],
      ["changed", "2026-01-05"],
      ["started", "2025-09-01"],
    ]);

    // History is insert-only, for every role.
    await expect(
      withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
        tx
          .update(staffEmploymentEvents)
          .set({ note: "rewritten" })
          .where(eq(staffEmploymentEvents.staffId, abena)),
      ),
    ).rejects.toThrow();
  });

  it("links a member once, shows what they teach, and keeps documents private with every download recorded", async () => {
    const s = await baseSchool();
    const teacherMembership = await membershipOf(s, s.teacher.userId);
    const basic4A = await classOf(s, s.classA);
    await updateClass(conn.app, s.owner, s.classA, {
      levelId: basic4A.levelId,
      campusId: basic4A.campusId,
      name: basic4A.name,
      classTeacherMembershipId: teacherMembership,
    });
    const id = await person(s);
    await linkStaffMember(conn.app, s.owner, id, { membershipId: teacherMembership });
    const other = await person(s, { firstName: "Esi" });
    await expect(
      linkStaffMember(conn.app, s.owner, other, { membershipId: teacherMembership }),
    ).rejects.toMatchObject({
      code: "member_linked",
    });
    const detail = await getStaff(conn.app, s.owner, id);
    expect(detail.account).toMatchObject({ name: "Teacher" });
    expect(detail.teaching.classTeacherOf).toEqual(["Basic 4A"]);

    const fileId = await uploadStaffDocument(conn.app, s.owner, id, { filename: "contract.pdf", bytes: PDF });
    // The head teacher sees staff records but not their documents.
    expect((await getStaff(conn.app, s.head, id)).documents).toBeNull();
    await expect(downloadStaffDocument(conn.app, s.head, id, fileId)).rejects.toBeInstanceOf(ForbiddenError);
    const file = await downloadStaffDocument(conn.app, s.owner, id, fileId);
    expect(file?.filename).toBe("contract.pdf");
    expect((await auditFor(s, id)).map((a) => a.action)).toContain("staff.document_downloaded");
    // Teachers have no access to staff records.
    expect(allowed(s.teacher, "staff.view")).toBe(false);
  });

  it("limits staff limited to some campuses to staff of those campuses", async () => {
    const s = await baseSchool();
    const mainCampus = (await classOf(s, s.classA)).campusId;
    const eastCampus = (await classOf(s, s.classB)).campusId;
    const main = await person(s, { campusId: mainCampus });
    const east = await person(s, { firstName: "Yaw", campusId: eastCampus });
    const none = await person(s, { firstName: "Ama" });
    const user = await createUser(conn.owner, "East Head");
    const m = await addMember(conn.owner, s.tenant.id, user.id, ["headteacher"]);
    await withTenant(conn.owner, { tenantId: s.tenant.id, userId: user.id }, (tx) =>
      tx
        .insert(membershipCampuses)
        .values({ tenantId: s.tenant.id, membershipId: m.id, campusId: eastCampus }),
    );
    const eastHead = (await resolveTenantContext(conn.app, s.tenant.slug, user.id)) as TenantContext;
    expect((await listStaff(conn.app, eastHead)).map((p) => p.id).sort()).toEqual([east, none].sort());
    await expect(getStaff(conn.app, eastHead, main)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      createStaff(conn.app, eastHead, {
        firstName: "Kwame",
        lastName: "Boateng",
        employmentType: "permanent",
        startedOn: "2026-01-05",
        campusId: mainCampus,
      }),
    ).rejects.toMatchObject({ code: "campus_scope" });
  });
});

describe("leave (HR-03)", () => {
  async function setup() {
    const s = await baseSchool();
    expect(await addSuggestedLeaveTypes(conn.app, s.owner)).toBe(6);
    const types = await listLeaveTypes(conn.app, s.owner);
    const annual = types.find((t) => t.name === "Annual leave")!;
    const teacherStaff = await person(s);
    await linkStaffMember(conn.app, s.owner, teacherStaff, {
      membershipId: await membershipOf(s, s.teacher.userId),
    });
    const headStaff = await person(s, { firstName: "Kwesi" });
    await linkStaffMember(conn.app, s.owner, headStaff, {
      membershipId: await membershipOf(s, s.head.userId),
    });
    return { s, annual, teacherStaff, headStaff };
  }

  it("is asked for, counted in working days, decided once by someone else, and balanced per year", async () => {
    const { s, annual, teacherStaff, headStaff } = await setup();
    // Monday 7 to Tuesday 15 December 2026: seven working days.
    const asked = await requestLeave(conn.app, s.teacher, {
      leaveTypeId: annual.id,
      startsOn: "2026-12-07",
      endsOn: "2026-12-15",
      reason: "Family wedding",
    });
    expect(asked).toMatchObject({ status: "pending", days: 7 });
    await expect(
      requestLeave(conn.app, s.teacher, {
        leaveTypeId: annual.id,
        startsOn: "2026-12-14",
        endsOn: "2026-12-16",
      }),
    ).rejects.toMatchObject({ code: "leave_overlap" });
    await expect(
      requestLeave(conn.app, s.teacher, {
        leaveTypeId: annual.id,
        startsOn: "2026-12-19",
        endsOn: "2026-12-20",
      }),
    ).rejects.toMatchObject({ code: "no_working_days" });
    // A teacher cannot record leave for someone else, nor decide it.
    await expect(
      requestLeave(conn.app, s.teacher, {
        staffId: headStaff,
        leaveTypeId: annual.id,
        startsOn: "2027-01-04",
        endsOn: "2027-01-05",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(decideLeave(conn.app, s.teacher, asked.id, { approve: true })).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    expect((await getLeaveOverview(conn.app, s.head)).waiting.map((w) => w.id)).toEqual([asked.id]);
    await expect(decideLeave(conn.app, s.head, asked.id, { approve: false })).rejects.toThrow("Say why");
    await decideLeave(conn.app, s.head, asked.id, { approve: true });
    await expect(
      decideLeave(conn.app, s.owner, asked.id, { approve: false, note: "No" }),
    ).rejects.toMatchObject({
      code: "leave_decided",
    });
    const mine = await getMyLeave(conn.app, s.teacher);
    expect(mine.balances.find((b) => b.name === "Annual leave")).toMatchObject({
      allowed: 15,
      taken: 7,
      left: 8,
    });

    // The head teacher's own request is decided by someone else.
    const own = await requestLeave(conn.app, s.head, {
      leaveTypeId: annual.id,
      startsOn: "2027-01-04",
      endsOn: "2027-01-05",
    });
    await expect(decideLeave(conn.app, s.head, own.id, { approve: true })).rejects.toMatchObject({
      code: "own_leave",
    });
    await decideLeave(conn.app, s.owner, own.id, { approve: true });

    // Beyond the year's balance: the approver must confirm.
    const long = await requestLeave(conn.app, s.teacher, {
      leaveTypeId: annual.id,
      startsOn: "2026-11-30",
      endsOn: "2026-12-04",
    });
    const more = await requestLeave(conn.app, s.teacher, {
      leaveTypeId: annual.id,
      startsOn: "2026-12-16",
      endsOn: "2026-12-18",
    });
    await decideLeave(conn.app, s.head, long.id, { approve: true });
    expect(
      (await getLeaveOverview(conn.app, s.head)).waiting.find((w) => w.id === more.id)?.overBalance,
    ).toBeNull();
    // Twelve approved, three more is exactly fifteen: allowed. One more day goes over.
    await decideLeave(conn.app, s.head, more.id, { approve: true });
    const extra = await requestLeave(conn.app, s.teacher, {
      leaveTypeId: annual.id,
      startsOn: "2026-12-21",
      endsOn: "2026-12-21",
    });
    await expect(decideLeave(conn.app, s.head, extra.id, { approve: true })).rejects.toMatchObject({
      code: "over_balance",
    });
    await decideLeave(conn.app, s.head, extra.id, { approve: true, confirmOverBalance: true });
    expect(
      (await getStaffLeave(conn.app, s.owner, teacherStaff)).balances.find((b) => b.name === "Annual leave"),
    ).toMatchObject({ taken: 16, left: -1 });

    // A request never changes, for any role.
    await expect(
      withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
        tx.update(leaveRequests).set({ days: 1 }).where(eq(leaveRequests.id, asked.id)),
      ),
    ).rejects.toThrow();
  });

  it("is recorded by an approver for someone, and cancelled by the person or an approver", async () => {
    const { s, annual, teacherStaff } = await setup();
    const sick = (await listLeaveTypes(conn.app, s.owner)).find((t) => t.name === "Sick leave")!;
    const recorded = await requestLeave(conn.app, s.head, {
      staffId: teacherStaff,
      leaveTypeId: sick.id,
      startsOn: "2026-11-02",
      endsOn: "2026-11-03",
      reason: "Malaria",
    });
    expect(recorded.status).toBe("approved");
    const waiting = await requestLeave(conn.app, s.teacher, {
      leaveTypeId: annual.id,
      startsOn: "2027-02-01",
      endsOn: "2027-02-02",
    });
    await cancelLeave(conn.app, s.teacher, waiting.id);
    // Leave that has started can only be cancelled by an approver.
    await expect(cancelLeave(conn.app, s.teacher, recorded.id)).rejects.toMatchObject({
      code: "leave_started",
    });
    await cancelLeave(conn.app, s.owner, recorded.id);
    const mine = await getMyLeave(conn.app, s.teacher);
    expect(mine.requests.map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    // Someone without a staff record is told so.
    await expect(
      requestLeave(conn.app, s.bursar, {
        leaveTypeId: annual.id,
        startsOn: "2027-03-01",
        endsOn: "2027-03-01",
      }),
    ).rejects.toMatchObject({ code: "no_staff_record" });
  });
});

describe("staff attendance (HR-04)", () => {
  it("marks each person once a day, never overwrites a newer mark, and shows approved leave", async () => {
    const s = await baseSchool();
    await addSuggestedLeaveTypes(conn.app, s.owner);
    const sick = (await listLeaveTypes(conn.app, s.owner)).find((t) => t.name === "Sick leave")!;
    const today = todayIn(s.tenant.timezone);
    const ama = await person(s, { firstName: "Ama", startedOn: "2025-01-06" });
    const yaw = await person(s, { firstName: "Yaw", startedOn: "2025-01-06" });
    await requestLeave(conn.app, s.owner, {
      staffId: yaw,
      leaveTypeId: sick.id,
      startsOn: today,
      endsOn: today,
    });

    const day = await getStaffDay(conn.app, s.head, today);
    expect(day.rows.find((r) => r.staffId === yaw)?.onLeave).toBe("Sick leave");
    await expect(
      saveStaffDay(conn.app, s.head, {
        date: today,
        marks: [{ staffId: yaw, status: "present", version: 0 }],
      }),
    ).rejects.toMatchObject({ code: "on_leave" });

    expect(
      await saveStaffDay(conn.app, s.head, {
        date: today,
        marks: [{ staffId: ama, status: "late", version: 0 }],
      }),
    ).toEqual({ saved: 1, conflicts: [] });
    // The owner corrects from the current version; the head teacher's older copy then conflicts.
    await saveStaffDay(conn.app, s.owner, {
      date: today,
      marks: [{ staffId: ama, status: "present", version: 1 }],
    });
    const stale = await saveStaffDay(conn.app, s.head, {
      date: today,
      marks: [{ staffId: ama, status: "absent", version: 1 }],
    });
    expect(stale.saved).toBe(0);
    expect(stale.conflicts[0]).toMatchObject({
      staffId: ama,
      yours: "absent",
      theirs: { status: "present", version: 2 },
    });
    expect(
      (await getStaffDay(conn.app, s.head, today)).rows.find((r) => r.staffId === ama)?.mark,
    ).toMatchObject({
      status: "present",
      version: 2,
    });
    expect((await auditFor(s, ama)).map((a) => a.action)).toEqual(
      expect.arrayContaining(["staff.attendance_marked", "staff.attendance_corrected"]),
    );
    await expect(getStaffDay(conn.app, s.teacher, today)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("the staff_hr module (HR-05, ENT-08)", () => {
  it("is refused when the school does not have it, and read-only for a while after an add-on ends", async () => {
    const s = await baseSchool();
    const admin = await platform;
    const id = await person(s);
    await updateEntitlements(conn.app, admin.id, s.tenant.id, {
      planName: "Essentials",
      maxCampuses: 2,
      maxStudents: null,
      maxSmsPerMonth: null,
      features: [...DEFAULT_PLAN_FEATURES],
    });
    const fresh = async () =>
      (await resolveTenantContext(conn.app, s.tenant.slug, s.owner.userId)) as TenantContext;
    await expect(listStaff(conn.app, await fresh())).rejects.toMatchObject({ code: "feature_not_included" });

    const today = todayIn(s.tenant.timezone);
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    const yesterday = d.toISOString().slice(0, 10);
    await grantModule(conn.app, admin.id, s.tenant.id, {
      module: "staff_hr",
      source: "trial",
      startsOn: "2026-01-01",
      endsOn: yesterday,
    });
    const owner = await fresh();
    expect(owner.modules.staff_hr?.state).toBe("read_only");
    expect(allowed(owner, "staff.view")).toBe(true);
    expect(allowed(owner, "staff.manage")).toBe(false);
    expect((await listStaff(conn.app, owner)).map((p) => p.id)).toEqual([id]);
    await expect(
      createStaff(conn.app, owner, {
        firstName: "A",
        lastName: "B",
        employmentType: "casual",
        startedOn: today,
      }),
    ).rejects.toMatchObject({ code: "module_read_only" });
  });
});
