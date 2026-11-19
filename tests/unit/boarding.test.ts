import { describe, expect, it } from "vitest";
import { allowed, PERMISSION_MODULES, type Access } from "@/server/authz/permissions";
import { MODULES } from "@/lib/modules";
import { exeatOverdueDays, fitsHouse } from "@/lib/boarding";

describe("boarding rules (BRD)", () => {
  it("places girls and boys only in their own houses, and anyone in a mixed one (BRD-01c)", () => {
    expect(fitsHouse("boys", "male")).toBe(true);
    expect(fitsHouse("boys", "female")).toBe(false);
    expect(fitsHouse("girls", "female")).toBe(true);
    expect(fitsHouse("girls", "male")).toBe(false);
    expect(fitsHouse("mixed", "female")).toBe(true);
    expect(fitsHouse("boys", null)).toBe(false);
  });

  it("counts an exeat overdue from the day after it was due, until the boarder is back (BRD-03)", () => {
    expect(exeatOverdueDays("2026-11-20", "2026-11-20", null)).toBe(0);
    expect(exeatOverdueDays("2026-11-20", "2026-11-23", null)).toBe(3);
    expect(exeatOverdueDays("2026-11-20", "2026-11-23", new Date())).toBe(0);
    expect(exeatOverdueDays("2026-11-20", "2026-11-18", null)).toBe(0);
  });

  it("gives the office houses and exeats, and the Accountant a view (BRD-05)", () => {
    const access = (role: Access["roles"][number]): Access => ({ roles: [role], features: ["boarding"] });
    expect(allowed(access("admin"), "boarding.manage")).toBe(true);
    expect(allowed(access("bursar"), "boarding.view")).toBe(true);
    expect(allowed(access("bursar"), "boarding.exeat")).toBe(false);
    expect(allowed(access("teacher"), "boarding.view")).toBe(false);
    // House staff get their access as a school grant.
    expect(
      allowed({ ...access("teacher"), schoolGrants: ["boarding.view", "boarding.exeat"] }, "boarding.exeat"),
    ).toBe(true);
    expect(allowed({ roles: ["owner"], features: [] }, "boarding.view")).toBe(false);
    for (const p of ["boarding.view", "boarding.manage", "boarding.exeat"] as const)
      expect(PERMISSION_MODULES[p]).toBe("boarding");
    expect(MODULES.boarding.routes).toEqual(["boarding"]);
  });
});
