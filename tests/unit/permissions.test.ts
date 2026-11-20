import { describe, expect, it } from "vitest";
import {
  assertCan,
  can,
  ForbiddenError,
  isRole,
  OPERATIONAL_ROLES,
  PERMISSIONS,
  ROLE_LABELS,
  type Permission,
} from "@/server/authz/permissions";

describe("permissions", () => {
  it("lets every role view its school", () => {
    for (const role of ["owner", "headteacher", "admin", "bursar", "teacher", "parent", "student"] as const) {
      expect(can([role], "school.view")).toBe(true);
    }
  });

  it("restricts member management and settings to owners and administrators", () => {
    expect(can(["owner"], "members.view")).toBe(true);
    expect(can(["admin"], "school.settings.manage")).toBe(true);
    expect(can(["teacher"], "members.view")).toBe(false);
    expect(can(["parent", "student"], "school.settings.manage")).toBe(false);
    expect(can(["bursar"], "school.settings.manage")).toBe(false);
  });

  it("lets head teachers see staff but not manage them or the school's settings", () => {
    expect(can(["headteacher"], "members.view")).toBe(true);
    expect(can(["headteacher"], "members.manage")).toBe(false);
    expect(can(["headteacher"], "school.settings.manage")).toBe(false);
    expect(can(["headteacher"], "audit.view")).toBe(false);
  });

  it("shows Ghanaian school role names", () => {
    expect([ROLE_LABELS.owner, ROLE_LABELS.headteacher, ROLE_LABELS.bursar]).toEqual([
      "Proprietor",
      "Head teacher",
      "Accountant",
    ]);
  });

  it("grants a permission when any held role allows it", () => {
    expect(can(["teacher", "admin"], "members.view")).toBe(true);
    expect(can([], "school.view")).toBe(false);
  });

  it("throws ForbiddenError when asserting a missing permission", () => {
    expect(() => assertCan(["teacher"], "audit.view")).toThrow(ForbiddenError);
    expect(() => assertCan(["owner"], "audit.view")).not.toThrow();
  });

  it("keeps each operational role to its own area", () => {
    const own: Record<(typeof OPERATIONAL_ROLES)[number], Permission[]> = {
      cashier: ["fees.view", "payments.record"],
      librarian: ["library.view", "library.manage"],
      storekeeper: ["inventory.view", "inventory.manage", "purchases.request"],
      transport_officer: ["transport.view", "transport.manage", "transport.trips"],
      front_desk: ["visitors.view", "visitors.manage", "pickup.view", "pickup.record"],
      nurse: ["students.view", "students.view_all", "students.medical"],
      admissions_officer: ["admissions.view", "admissions.manage"],
    };
    const everyone: Permission[] = [
      "school.view",
      "events.view",
      "leave.request",
      "payroll.own",
      "safeguarding.report",
      "maintenance.report",
    ];
    for (const role of OPERATIONAL_ROLES) {
      const granted = PERMISSIONS.filter((p) => can([role], p)).sort();
      expect(granted, role).toEqual([...own[role], ...everyone].sort());
    }
  });

  it("never lets an operational role void receipts, manage members or change settings", () => {
    for (const role of OPERATIONAL_ROLES) {
      for (const p of ["payments.void", "fees.manage", "members.manage", "school.settings.manage"] as const)
        expect(can([role], p), `${role} ${p}`).toBe(false);
    }
  });

  it("recognises only known roles", () => {
    expect(isRole("bursar")).toBe(true);
    expect(isRole("superuser")).toBe(false);
  });
});
