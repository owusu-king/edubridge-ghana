import { describe, expect, it } from "vitest";
import { allowed, PERMISSION_MODULES, type Access } from "@/server/authz/permissions";
import { MODULES } from "@/lib/modules";
import { collectorAllowed, latestByStudent } from "@/lib/visitors";

const at = (iso: string) => new Date(iso);

describe("visitors and pickup rules (VIS)", () => {
  it("allows a named collector until ended or past their last day (VIS-02b)", () => {
    expect(collectorAllowed({ endedAt: null, validUntil: null }, "2026-11-17")).toBe(true);
    // The last day is included.
    expect(collectorAllowed({ endedAt: null, validUntil: "2026-11-17" }, "2026-11-17")).toBe(true);
    expect(collectorAllowed({ endedAt: null, validUntil: "2026-11-16" }, "2026-11-17")).toBe(false);
    expect(collectorAllowed({ endedAt: at("2026-11-10T08:00:00Z"), validUntil: null }, "2026-11-17")).toBe(
      false,
    );
  });

  it("takes each child's latest record of the day, leaving out cancelled ones (VIS-02d)", () => {
    const records = [
      { id: "a", studentId: "s1", recordedAt: at("2026-11-17T14:00:00Z"), cancelledAt: null },
      {
        id: "b",
        studentId: "s1",
        recordedAt: at("2026-11-17T14:30:00Z"),
        cancelledAt: at("2026-11-17T14:31:00Z"),
      },
      { id: "c", studentId: "s2", recordedAt: at("2026-11-17T14:10:00Z"), cancelledAt: null },
      { id: "d", studentId: "s2", recordedAt: at("2026-11-17T14:05:00Z"), cancelledAt: null },
    ];
    const latest = latestByStudent(records);
    expect(latest.get("s1")?.id).toBe("a");
    expect(latest.get("s2")?.id).toBe("c");
    expect(latest.has("s3")).toBe(false);
  });

  it("gives the office visitors, everyone on gate duty pickup, and the office the lists (VIS-03)", () => {
    const access = (role: Access["roles"][number]): Access => ({
      roles: [role],
      features: ["visitors_pickup"],
    });
    expect(allowed(access("admin"), "visitors.manage")).toBe(true);
    expect(allowed(access("teacher"), "visitors.view")).toBe(false);
    expect(allowed(access("teacher"), "pickup.record")).toBe(true);
    expect(allowed(access("teacher"), "pickup.manage")).toBe(false);
    expect(allowed(access("bursar"), "pickup.view")).toBe(false);
    // Without the module, no role has it.
    expect(allowed({ roles: ["owner"], features: [] }, "pickup.view")).toBe(false);
    for (const p of [
      "visitors.view",
      "visitors.manage",
      "pickup.view",
      "pickup.record",
      "pickup.manage",
    ] as const)
      expect(PERMISSION_MODULES[p]).toBe("visitors_pickup");
    expect(MODULES.visitors_pickup.routes).toEqual(["visitors", "pickup"]);
  });
});
