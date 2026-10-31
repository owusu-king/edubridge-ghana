import { describe, expect, it } from "vitest";
import { assertCan, can, ForbiddenError, isRole, ROLE_LABELS } from "@/server/authz/permissions";

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

  it("recognises only known roles", () => {
    expect(isRole("bursar")).toBe(true);
    expect(isRole("superuser")).toBe(false);
  });
});
