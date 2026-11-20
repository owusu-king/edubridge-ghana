import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import { getOperationsNow } from "@/server/dashboard/board-summary";
import { getAttendanceOverview } from "@/server/dashboard/school";
import { voidPayment } from "@/server/fees/payments";
import { setupFeeItems } from "@/server/fees/structure";
import { updateMember } from "@/server/members/service";
import { listMembers } from "@/server/tenancy/service";
import { addMember, connect, createUser } from "../support/fixtures";
import { billedSchool } from "../support/school";

const conn = connect();
afterAll(() => conn.close());

/** Operational roles (2026-11-18): a cashier, librarian or storekeeper no longer needs to be an Administrator. */
describe("operational roles", () => {
  it("lets a cashier take payments but not void them or change fees", async () => {
    const s = await billedSchool(conn, { roles: ["cashier"], tuition: "500" });
    const student = await s.addStudent("Esi", "Owusu");
    await s.bill();
    const cashier = await s.ctx("cashier");

    const paid = await s.pay(student.id, "200", {}, cashier);
    expect(paid.receiptNumber).toBe("R000001");
    await expect(voidPayment(conn.app, cashier, paid.paymentId, { reason: "Entered twice" })).rejects.toThrow(
      ForbiddenError,
    );
    await expect(setupFeeItems(conn.app, cashier, { names: ["Bus"] })).rejects.toThrow(ForbiddenError);
  });

  it("can be given by an Administrator, and keeps the home page's school-wide figures closed", async () => {
    const s = await billedSchool(conn, { roles: ["admin"] });
    const staffUser = await createUser(conn.owner, "Abena Librarian");
    const membership = await addMember(conn.owner, s.tenant.id, staffUser.id, ["teacher"]);
    const admin = await s.ctx("admin");

    await updateMember(conn.app, admin, membership.id, { roles: ["librarian"], campusIds: null });
    const member = (await listMembers(conn.app, admin)).find((m) => m.membershipId === membership.id)!;
    expect(member.roles).toEqual(["librarian"]);

    const { resolveTenantContext } = await import("@/server/tenancy/service");
    const librarian = (await resolveTenantContext(conn.app, s.tenant.slug, staffUser.id))!;
    expect(librarian.roles).toEqual(["librarian"]);
    expect(await getAttendanceOverview(conn.app, librarian, s.termId, s.today)).toBeNull();
    const operations = await getOperationsNow(conn.app, librarian);
    expect(operations?.leaveWaiting).toBeNull();
    expect(operations?.libraryOverdue).toBe(0);
  });
});
