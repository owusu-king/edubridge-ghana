import { describe, expect, it } from "vitest";
import { assertCan, can, ForbiddenError, isRole } from "@/server/authz/permissions";

describe("permissions", () => {
  it("lets every role view its school", () => {
    for (const role of ["owner", "admin", "bursar", "teacher", "parent", "student"] as const) {
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
