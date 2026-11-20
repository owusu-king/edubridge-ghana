import { describe, expect, it } from "vitest";
import { allowed, assertAllowed, READ_PERMISSIONS } from "@/server/authz/permissions";
import { FEATURES } from "@/lib/plan";
import {
  SUGGESTED_LEAVE_TYPES,
  formatStaffNumber,
  leaveBalances,
  leaveDaysInYear,
  overlaps,
  workingDays,
} from "@/lib/staff";

describe("working days (HR-03b)", () => {
  it("count Monday to Friday, less the school's holidays", () => {
    // Friday 4 to Monday 14 December 2026.
    expect(workingDays("2026-12-04", "2026-12-14")).toHaveLength(7);
    expect(workingDays("2026-12-04", "2026-12-14", new Set(["2026-12-07"]))).toHaveLength(6);
    expect(workingDays("2026-12-19", "2026-12-20")).toEqual([]);
  });

  it("split leave across calendar years by the days in each", () => {
    const leave = { startsOn: "2026-12-28", endsOn: "2027-01-08" };
    expect(leaveDaysInYear(leave, 2026)).toBe(4);
    expect(leaveDaysInYear(leave, 2027)).toBe(6);
    expect(leaveDaysInYear(leave, 2028)).toBe(0);
  });
});

describe("leave balances (HR-03d)", () => {
  it("subtract approved days falling in the year; types without a limit only count", () => {
    const types = [
      { id: "annual", name: "Annual leave", daysPerYear: 15 },
      { id: "sick", name: "Sick leave", daysPerYear: null },
    ];
    const approved = [
      { leaveTypeId: "annual", startsOn: "2026-12-28", endsOn: "2027-01-08" },
      { leaveTypeId: "annual", startsOn: "2026-03-02", endsOn: "2026-03-06" },
      { leaveTypeId: "sick", startsOn: "2026-05-04", endsOn: "2026-05-05" },
    ];
    expect(leaveBalances(types, approved, 2026)).toEqual([
      { leaveTypeId: "annual", name: "Annual leave", allowed: 15, taken: 9, left: 6 },
      { leaveTypeId: "sick", name: "Sick leave", allowed: null, taken: 2, left: null },
    ]);
  });

  it("start from the Labour Act minimums as suggestions, and overlap by any shared day", () => {
    expect(SUGGESTED_LEAVE_TYPES.find((t) => t.name === "Annual leave")?.daysPerYear).toBe(15);
    expect(
      overlaps(
        { startsOn: "2026-12-07", endsOn: "2026-12-11" },
        { startsOn: "2026-12-11", endsOn: "2026-12-14" },
      ),
    ).toBe(true);
    expect(
      overlaps(
        { startsOn: "2026-12-07", endsOn: "2026-12-10" },
        { startsOn: "2026-12-11", endsOn: "2026-12-14" },
      ),
    ).toBe(false);
    expect(formatStaffNumber(7)).toBe("S0007");
  });
});

describe("staff permissions and read-only access (HR-05, ENT-08)", () => {
  const owner = { roles: ["owner"] as const, features: [...FEATURES] };
  const withoutHr = FEATURES.filter((f) => f !== "staff_hr");

  it("give staff records to leaders and the office, documents to the Proprietor and Administrator", () => {
    expect(allowed({ roles: ["headteacher"], features: [...FEATURES] }, "staff.manage")).toBe(true);
    expect(allowed({ roles: ["headteacher"], features: [...FEATURES] }, "staff.documents")).toBe(false);
    expect(allowed({ roles: ["bursar"], features: [...FEATURES] }, "staff.view")).toBe(false);
    expect(allowed({ roles: ["teacher"], features: [...FEATURES] }, "leave.request")).toBe(true);
    expect(allowed({ roles: ["teacher"], features: [...FEATURES] }, "leave.approve")).toBe(false);
    expect(allowed(owner, "staff.documents")).toBe(true);
  });

  it("keep viewing and downloading, but not changing, while the module is read-only", () => {
    const readOnly = {
      ...owner,
      features: withoutHr,
      modules: { staff_hr: { state: "read_only" as const } },
    };
    expect([...READ_PERMISSIONS]).toEqual([
      "staff.view",
      "staff.documents",
      "payroll.view",
      "payroll.own",
      "visitors.view",
      "pickup.view",
      "transport.view",
      "inventory.view",
      "library.view",
      "boarding.view",
      "forecasting.view",
      "early_warning.view",
      "finance.view",
    ]);
    expect(allowed(readOnly, "staff.view")).toBe(true);
    expect(allowed(readOnly, "staff.documents")).toBe(true);
    expect(allowed(readOnly, "staff.manage")).toBe(false);
    expect(() => assertAllowed(readOnly, "leave.request")).toThrow("Staff and HR has ended for this school");
    const off = { ...owner, features: withoutHr, modules: { staff_hr: { state: "off" as const } } };
    expect(allowed(off, "staff.view")).toBe(false);
    expect(() => assertAllowed(off, "staff.view")).toThrow("is not included in this school's plan");
  });
});
