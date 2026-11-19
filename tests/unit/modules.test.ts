import { describe, expect, it } from "vitest";
import {
  CORE_MODULE_IDS,
  MODULES,
  MODULE_LIST,
  PLAN_CHOICES,
  PLAN_MODULE_IDS,
  activeModules,
  addOnInvoiceLines,
  isReleasedTo,
  missingDependencies,
  moduleForSchoolPath,
  resolveModules,
  type ModuleDefinition,
  type ResolveInput,
} from "@/lib/modules";
import { DEFAULT_PLAN_FEATURES, FEATURES } from "@/lib/plan";
import { PERMISSION_MODULES, PERMISSIONS, moduleOf } from "@/server/authz/permissions";

describe("the module registry (MOD-01)", () => {
  it("has one definition per id, core and plan modules kept apart", () => {
    const ids = MODULE_LIST.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...CORE_MODULE_IDS, ...PLAN_MODULE_IDS].sort());
    for (const id of CORE_MODULE_IDS) {
      expect(MODULES[id].availability).toBe("core");
      expect(MODULES[id].purchasable).toBe(false);
      expect(MODULES[id].routes).toEqual([]);
    }
    for (const id of PLAN_MODULE_IDS) expect(MODULES[id].availability).toBe("plan");
  });

  it("keeps the R1–R3 plan modules exactly as they were stored", () => {
    expect(FEATURES.slice(0, 8)).toEqual([
      "attendance",
      "assessment",
      "parent_view",
      "fee_reminders",
      "mobile_money",
      "assistant",
      "admissions",
      "whatsapp",
    ]);
    for (const id of FEATURES.slice(0, 8)) expect(MODULES[id].stage).toBe("general");
    // A new plan still starts with everything but the paid add-ons (assistant, WhatsApp).
    expect([...DEFAULT_PLAN_FEATURES]).toEqual([
      "attendance",
      "assessment",
      "parent_view",
      "fee_reminders",
      "mobile_money",
      "admissions",
    ]);
  });

  it("releases every module to every school that has it (founder, 2026-11-18; REL-01)", () => {
    for (const m of MODULE_LIST) expect(m.stage).toBe("general");
    // The Command Center is the overview (D-R5-9); it can be named in a plan but is never sold on its own.
    expect(PLAN_CHOICES).toContain("command_center");
    expect(MODULES.command_center.purchasable).toBe(false);
    // D-R4-4: safeguarding is in plans, never sold on its own.
    expect(MODULES.safeguarding.purchasable).toBe(false);
  });

  it("declares dependencies that exist and never go round in a circle (MOD-03)", () => {
    const visit = (id: string, path: string[]): void => {
      expect(path).not.toContain(id);
      for (const r of MODULES[id as keyof typeof MODULES].requires) {
        expect(MODULES[r]).toBeDefined();
        visit(r, [...path, id]);
      }
    };
    for (const m of MODULE_LIST) visit(m.id, []);
    expect(MODULES.payroll.requires).toEqual(["staff_hr"]);
    expect(missingDependencies("payroll", [])).toEqual(["staff_hr"]);
    expect(missingDependencies("payroll", ["staff_hr"])).toEqual([]);
  });
});

describe("permissions and modules (MOD-02)", () => {
  it("name a module for every permission", () => {
    for (const p of PERMISSIONS) expect(MODULES[PERMISSION_MODULES[p]]).toBeDefined();
  });

  it("gate exactly the permissions R3 gated, by the same modules", () => {
    // R1–R3 permissions only: R4 modules add their own (staff_hr: HR-05).
    const gated = Object.fromEntries(
      PERMISSIONS.map((p) => [p, moduleOf(p)]).filter(
        ([, m]) => m !== null && !["R4", "R5"].includes(MODULES[m as keyof typeof MODULES].release),
      ),
    );
    expect(gated).toEqual({
      "attendance.take": "attendance",
      "attendance.manage": "attendance",
      "assessment.enter": "assessment",
      "reports.publish": "assessment",
      "fees.remind": "fee_reminders",
      "parents.access.manage": "parent_view",
      "assistant.use": "assistant",
      "assistant.manage": "assistant",
      "admissions.view": "admissions",
      "admissions.manage": "admissions",
    });
  });
});

describe("a module's own pages (ENT-03)", () => {
  it("are found from the path the proxy sets", () => {
    expect(moduleForSchoolPath("/s/kpone/attendance", "kpone")).toBe("attendance");
    expect(moduleForSchoolPath("/s/kpone/attendance/2026-11-17/abc", "kpone")).toBe("attendance");
    expect(moduleForSchoolPath("/s/kpone/settings/attendance", "kpone")).toBe("attendance");
    expect(moduleForSchoolPath("/s/kpone/assessment/x/students/y/pdf", "kpone")).toBe("assessment");
    expect(moduleForSchoolPath("/s/kpone/admissions?tab=pipeline", "kpone")).toBe("admissions");
    expect(moduleForSchoolPath("/s/kpone/settings/assistant", "kpone")).toBe("assistant");
    // Pages of core modules, and of modules that leave pages open on purpose (Mobile Money settles payments
    // already in flight), are not refused centrally.
    expect(moduleForSchoolPath("/s/kpone/settings", "kpone")).toBeNull();
    expect(moduleForSchoolPath("/s/kpone/fees/mobile-money", "kpone")).toBeNull();
    expect(moduleForSchoolPath("/s/kpone/attendances", "kpone")).toBeNull();
    expect(moduleForSchoolPath("/s/other/attendance", "kpone")).toBeNull();
  });
});

const base: ResolveInput = {
  planModules: [],
  grants: [],
  releaseAccess: [],
  isDemo: false,
  production: true,
  today: "2026-11-17",
  readOnlyDays: 90,
};

describe("resolving a school's modules (ENT-01)", () => {
  it("gives every module to a school without a plan row, as before, but never an unreleased one", () => {
    const states = resolveModules({ ...base, planModules: null });
    expect(activeModules(states)).toEqual([...PLAN_MODULE_IDS]);
    // A module still in development stays off in production, and can be reached outside it.
    const registry = { library: { ...MODULES.library, stage: "in_development" as const } };
    const inDevelopment = { ...base, planModules: null, modules: registry };
    expect(resolveModules(inDevelopment).library).toMatchObject({ state: "off", unreleased: true });
    expect(resolveModules({ ...inDevelopment, production: false }).library?.state).toBe("active");
    expect(states.fees).toMatchObject({ state: "active", source: "core" });
  });

  it("adds an add-on, trial or promotion only for the days it covers", () => {
    const grant = { module: "attendance", source: "trial" as const, startsOn: "2026-11-01", endedOn: null };
    const on = resolveModules({ ...base, grants: [{ ...grant, endsOn: "2026-11-30" }] });
    expect(on.attendance).toMatchObject({ state: "active", source: "trial", endsOn: "2026-11-30" });
    const later = resolveModules({ ...base, grants: [{ ...grant, startsOn: "2026-12-01", endsOn: null }] });
    expect(later.attendance?.state).toBe("off");
    // Ended early yesterday: R3 modules are off at once (unchanged behaviour, D-R4-5).
    const ended = resolveModules({ ...base, grants: [{ ...grant, endsOn: null, endedOn: "2026-11-17" }] });
    expect(ended.attendance?.state).toBe("off");
  });

  it("keeps an R4 module read-only for the window after its add-on ends, then off (ENT-08)", () => {
    const grant = {
      module: "library",
      source: "addon" as const,
      startsOn: "2026-01-01",
      endsOn: "2026-10-31",
      endedOn: null,
    };
    const input = { ...base, production: false, grants: [grant] };
    expect(resolveModules(input).library).toMatchObject({ state: "read_only", endsOn: "2026-10-31" });
    expect(resolveModules({ ...input, today: "2027-01-29" }).library?.state).toBe("read_only");
    expect(resolveModules({ ...input, today: "2027-01-30" }).library?.state).toBe("off");
    expect(resolveModules({ ...input, readOnlyDays: 0 }).library?.state).toBe("off");
  });

  it("gives safeguarding to every school whatever its plan, once released (D-R4-4)", () => {
    const input = { ...base, planModules: ["attendance"] };
    expect(resolveModules(input).safeguarding).toMatchObject({ state: "active", source: "plan" });
    const testing = { safeguarding: { ...MODULES.safeguarding, stage: "internal_testing" as const } };
    expect(resolveModules({ ...input, modules: testing }).safeguarding).toMatchObject({
      state: "off",
      unreleased: true,
    });
  });

  it("switches a module off when one it needs is not active (MOD-03)", () => {
    const states = resolveModules({ ...base, production: false, planModules: ["payroll", "whatsapp"] });
    expect(states.payroll).toMatchObject({ state: "off", missing: ["staff_hr"] });
    expect(states.whatsapp).toMatchObject({ state: "off", missing: ["parent_view"] });
    const both = resolveModules({ ...base, production: false, planModules: ["payroll", "staff_hr"] });
    expect(both.payroll?.state).toBe("active");
  });

  it("releases pilot and internal-testing modules only to schools given access, and to demo schools (REL-02)", () => {
    const def = (stage: ModuleDefinition["stage"]): ModuleDefinition => ({
      ...MODULES.library,
      stage,
      requires: [],
    });
    const registry = { library: def("pilot") };
    const input = { ...base, planModules: ["library"], modules: registry };
    expect(resolveModules(input).library).toMatchObject({ state: "off", unreleased: true });
    expect(resolveModules({ ...input, releaseAccess: ["library"] }).library?.state).toBe("active");
    expect(resolveModules({ ...input, isDemo: true }).library?.state).toBe("active");
    expect(isReleasedTo("in_development", { hasAccess: true, isDemo: true, production: true })).toBe(false);
    expect(isReleasedTo("retired", { hasAccess: true, isDemo: true, production: false })).toBe(false);
    expect(isReleasedTo("deprecated", { hasAccess: false, isDemo: false, production: true })).toBe(true);
  });
});

describe("add-ons on an invoice (SUB-09)", () => {
  it("lists priced add-ons covering the date, per student where agreed", () => {
    const g = {
      source: "addon" as const,
      startsOn: "2026-09-01",
      endsOn: null,
      endedAt: null,
      priceUnit: "flat" as const,
    };
    const lines = addOnInvoiceLines(
      [
        { ...g, module: "attendance", pricePesewas: 30_000 },
        { ...g, module: "admissions", pricePesewas: 500, priceUnit: "per_student" },
        { ...g, module: "whatsapp", pricePesewas: null, priceUnit: null },
        { ...g, module: "assistant", pricePesewas: 10_000, endedAt: new Date() },
        { ...g, module: "assessment", pricePesewas: 10_000, startsOn: "2026-12-01" },
      ],
      "2026-11-17",
      240,
    );
    expect(lines).toEqual([
      { description: "Attendance (add-on)", quantity: 1, unitPesewas: 30_000 },
      { description: "Admissions (add-on), per active student", quantity: 240, unitPesewas: 500 },
    ]);
  });
});
