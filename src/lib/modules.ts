/**
 * The module registry (MOD-01, ADR 0003): every part of EduBridge a school can have, built or planned, with
 * what it needs and how it is sold. Module definitions are code (they own routes, permissions and tables);
 * plans, prices and each school's add-ons are configuration in the database.
 *
 * Three separate questions are answered for each school (ADR 0003 §5):
 *  - released: the module's stage lets this school reach it (release control, here and module_release_access);
 *  - entitled: the school's plan or one of its add-ons, trials or promotions includes it (tenant_entitlements,
 *    school_modules);
 *  - permitted: the member's role allows the action (src/server/authz/permissions.ts).
 */

/** Identifiers stored in the database (plans, add-ons): never rename one. */
export const CORE_MODULE_IDS = [
  "school_core",
  "students",
  "academic_structure",
  "fees",
  "communication",
  "timetable",
  "insights",
  "transfer_passport",
  "api_sync",
] as const;

/** Modules a plan may include or a school may add. The first eight are the R1–R3 plan modules. */
export const PLAN_MODULE_IDS = [
  "attendance",
  "assessment",
  "parent_view",
  "fee_reminders",
  "mobile_money",
  "assistant",
  "admissions",
  "whatsapp",
  "staff_hr",
  "payroll",
  "safeguarding",
  "visitors_pickup",
  "transport",
  "inventory_assets",
  "library",
  "boarding",
  "forecasting",
  "early_warning",
  "command_center",
  "ai_drafting",
] as const;

export type CoreModuleId = (typeof CORE_MODULE_IDS)[number];
export type PlanModuleId = (typeof PLAN_MODULE_IDS)[number];
export type ModuleId = CoreModuleId | PlanModuleId;

/**
 * Release stages (REL-01). Being built never makes a module available, and selling it never releases it.
 *  planned           listed only; never reachable
 *  in_development    reachable outside production only
 *  internal_testing  demo schools, and schools given release access
 *  ready             finished, waiting for a release decision (reach as internal_testing)
 *  pilot             schools given release access (and demo schools)
 *  general           every entitled school
 *  deprecated        no new sales; schools that have it keep it
 *  retired           off for everyone; data kept and exportable
 */
export const MODULE_STAGES = [
  "planned",
  "in_development",
  "internal_testing",
  "ready",
  "pilot",
  "general",
  "deprecated",
  "retired",
] as const;
export type ModuleStage = (typeof MODULE_STAGES)[number];

export const MODULE_STAGE_LABELS: Record<ModuleStage, string> = {
  planned: "Planned",
  in_development: "In development",
  internal_testing: "Internal testing",
  ready: "Ready for release",
  pilot: "Pilot",
  general: "Available",
  deprecated: "Deprecated",
  retired: "Retired",
};

export const MODULE_CATEGORIES = {
  platform: "Platform",
  students: "Students and families",
  academics: "Academics",
  finance: "Finance",
  communication: "Communication",
  growth: "Growth",
  staff: "Staff",
  welfare: "Welfare and safety",
  operations: "Operations",
  intelligence: "Intelligence",
} as const;
export type ModuleCategory = keyof typeof MODULE_CATEGORIES;

export interface ModuleDefinition {
  id: ModuleId;
  name: string;
  description: string;
  category: ModuleCategory;
  /** The release it belongs to (`01` §4). */
  release: "R0" | "R1" | "R2" | "R3" | "R4" | "R5";
  stage: ModuleStage;
  /** core: in every school, never sold; plan: plans may include it. */
  availability: "core" | "plan";
  /** Whether a school can add it on its own, outside its plan (an add-on). */
  purchasable: boolean;
  /** Included when EduBridge staff create a plan or school without choosing. */
  defaultInNewPlans: boolean;
  /** Modules that must be active for this one to work. */
  requires: readonly ModuleId[];
  /**
   * Staff pages under /s/{school}/ that belong only to this module: refused centrally ("not found") when the
   * module is not active (ENT-03). Pages shared with other modules are guarded by their permissions.
   */
  routes: readonly string[];
  /** After an add-on, trial or promotion ends: read-only for a window, then off (D-R4-5; R4 modules). */
  readOnlyAfterEnd: boolean;
  /** In every school's plan whatever the plan lists (D-R4-4: safeguarding); release stages still apply. */
  everyPlan?: boolean;
}

type Def = Omit<ModuleDefinition, "availability" | "purchasable" | "defaultInNewPlans" | "readOnlyAfterEnd"> &
  Partial<Pick<ModuleDefinition, "purchasable" | "defaultInNewPlans" | "readOnlyAfterEnd">>;

const core = (d: Omit<Def, "requires" | "routes" | "stage">): ModuleDefinition => ({
  ...d,
  stage: "general",
  availability: "core",
  purchasable: false,
  defaultInNewPlans: true,
  requires: [],
  routes: [],
  readOnlyAfterEnd: false,
});

const sold = (d: Def): ModuleDefinition => ({
  purchasable: true,
  defaultInNewPlans: false,
  readOnlyAfterEnd: d.release === "R4" || d.release === "R5",
  ...d,
  availability: "plan",
});

const DEFINITIONS: readonly ModuleDefinition[] = [
  core({
    id: "school_core",
    name: "School administration",
    description:
      "School profile, campuses, staff and roles, security, audit log, support access, setup guide, overview and data export.",
    category: "platform",
    release: "R0",
  }),
  core({
    id: "students",
    name: "Students and families",
    description: "Students, guardians, families, imports, photos, documents and medical information.",
    category: "students",
    release: "R1",
  }),
  core({
    id: "academic_structure",
    name: "Classes and calendar",
    description: "Academic years, terms, holidays, levels, classes, moving students between terms.",
    category: "academics",
    release: "R1",
  }),
  core({
    id: "fees",
    name: "Fees and payments",
    description:
      "Fee structures, billing, payments and receipts, discounts, payment plans, statements, who owes what and finance reports.",
    category: "finance",
    release: "R1",
  }),
  core({
    id: "communication",
    name: "Announcements and events",
    description: "Announcements, events, consent forms, receipts by SMS and each family's message history.",
    category: "communication",
    release: "R1",
  }),
  core({
    id: "timetable",
    name: "Timetable",
    description: "The school day's periods and each class's lessons.",
    category: "academics",
    release: "R2",
  }),
  core({
    id: "insights",
    name: "School insights",
    description: "Term-by-term enrolment, results, attendance and money, and students who may need support.",
    category: "intelligence",
    release: "R3",
  }),
  core({
    id: "transfer_passport",
    name: "Transfer Passport",
    description: "Signed learner records and transfers between schools.",
    category: "students",
    release: "R3",
  }),
  core({
    id: "api_sync",
    name: "Devices and offline sync",
    description: "Sign-in for devices, the API and working without a connection.",
    category: "platform",
    release: "R3",
  }),

  sold({
    id: "attendance",
    name: "Attendance",
    description: "Daily class registers, including without a connection, lesson registers and absence SMS.",
    category: "academics",
    release: "R2",
    stage: "general",
    defaultInNewPlans: true,
    requires: [],
    routes: ["attendance", "settings/attendance"],
  }),
  sold({
    id: "assessment",
    name: "Assessment and report cards",
    description: "Score sheets, report cards and printing.",
    category: "academics",
    release: "R2",
    stage: "general",
    defaultInNewPlans: true,
    requires: [],
    routes: ["assessment"],
  }),
  sold({
    id: "parent_view",
    name: "Parent view",
    description: "Families sign in by SMS code to see fees, receipts, report cards and school news.",
    category: "students",
    release: "R1",
    stage: "general",
    defaultInNewPlans: true,
    requires: [],
    routes: [],
  }),
  sold({
    id: "fee_reminders",
    name: "SMS fee reminders",
    description: "Reminders to families who owe, by SMS, sent by staff or automatically.",
    category: "finance",
    release: "R1",
    stage: "general",
    defaultInNewPlans: true,
    requires: [],
    routes: [],
  }),
  sold({
    id: "mobile_money",
    name: "Mobile Money",
    description: "Payment prompts to a payer's phone, receipted once the provider confirms.",
    category: "finance",
    release: "R1",
    stage: "general",
    defaultInNewPlans: true,
    requires: [],
    // Fees, Mobile Money stays open without the module so payments already in flight are still settled.
    routes: [],
  }),
  sold({
    id: "assistant",
    name: "School assistant (AI)",
    description: "Questions about the school answered from its own records, for leaders and the accountant.",
    category: "intelligence",
    release: "R3",
    stage: "general",
    requires: [],
    routes: ["assistant", "settings/assistant"],
  }),
  sold({
    id: "admissions",
    name: "Admissions",
    description:
      "Inquiries and applications through to enrolment, with online applications if the school wants them.",
    category: "growth",
    release: "R3",
    stage: "general",
    defaultInNewPlans: true,
    requires: [],
    routes: ["admissions"],
  }),
  sold({
    id: "whatsapp",
    name: "WhatsApp messages",
    description:
      "Receipts, fee notices, absences, announcements, forms and reminders by WhatsApp to families who choose it, instead of SMS.",
    category: "communication",
    release: "R3",
    stage: "general",
    // Families turn WhatsApp on in the parent view.
    requires: ["parent_view"],
    routes: [],
  }),

  sold({
    id: "staff_hr",
    name: "Staff and HR",
    description:
      "Staff profiles, employment records, departments and positions, staff documents, leave and staff attendance.",
    category: "staff",
    release: "R4",
    stage: "general",
    requires: [],
    routes: ["staff", "leave"],
  }),
  sold({
    id: "payroll",
    name: "Payroll records",
    description:
      "Salary structures, monthly payroll records, payslips and payroll reports. No statutory tax calculation.",
    category: "staff",
    release: "R4",
    stage: "general",
    requires: ["staff_hr"],
    routes: ["payroll"],
  }),
  sold({
    id: "safeguarding",
    name: "Safeguarding",
    description:
      "Restricted incident and case records, seen only by the school's designated safeguarding leads.",
    category: "welfare",
    release: "R4",
    stage: "general",
    // D-R4-4: in every plan, never sold on its own.
    purchasable: false,
    requires: [],
    routes: ["safeguarding", "settings/safeguarding"],
    everyPlan: true,
  }),
  sold({
    id: "visitors_pickup",
    name: "Visitors and pickup",
    description: "Visitor sign-in, authorised collectors for each child and a record of every pickup.",
    category: "welfare",
    release: "R4",
    stage: "general",
    requires: [],
    routes: ["visitors", "pickup"],
  }),
  sold({
    id: "transport",
    name: "Transport",
    description:
      "Vehicles, drivers, routes and stops, students on each route, transport fees and trip records.",
    category: "operations",
    release: "R4",
    stage: "general",
    requires: [],
    routes: ["transport"],
  }),
  sold({
    id: "inventory_assets",
    name: "Inventory and assets",
    description: "Stock, the asset register, suppliers, purchase requests and maintenance requests.",
    category: "operations",
    release: "R4",
    stage: "general",
    requires: [],
    routes: ["inventory"],
  }),
  sold({
    id: "library",
    name: "Library",
    description: "Catalogue, copies, loans and returns, overdue books, reservations and optional fines.",
    category: "operations",
    release: "R4",
    stage: "general",
    requires: [],
    routes: ["library"],
  }),
  sold({
    id: "boarding",
    name: "Boarding",
    description: "Houses, rooms and beds, boarders each term, exeat and boarding fees.",
    category: "operations",
    release: "R4",
    stage: "general",
    requires: [],
    routes: ["boarding"],
  }),

  sold({
    id: "forecasting",
    name: "Collection forecasting",
    description: "What the school can expect to collect, and when, and checks on the books.",
    category: "intelligence",
    release: "R5",
    stage: "general",
    requires: [],
    routes: ["fees/forecast", "fees/checks"],
  }),
  sold({
    id: "early_warning",
    name: "Early-warning indicators",
    description: "Students who may need support, from the records, for their teachers to review.",
    category: "intelligence",
    release: "R5",
    stage: "general",
    purchasable: false,
    requires: ["attendance", "assessment"],
    routes: ["early-warning"],
  }),
  sold({
    id: "command_center",
    name: "Command Center",
    description: "The school's financial, academic, enrolment and operational health in one place.",
    category: "intelligence",
    release: "R5",
    stage: "general",
    purchasable: false,
    requires: [],
    routes: [],
  }),
  sold({
    id: "ai_drafting",
    name: "AI drafting tools",
    description: "Drafts of remarks, messages and reports, always approved by a person.",
    category: "intelligence",
    release: "R5",
    stage: "general",
    purchasable: false,
    requires: [],
    routes: ["board-report"],
  }),
];

export const MODULES: Readonly<Record<ModuleId, ModuleDefinition>> = Object.fromEntries(
  DEFINITIONS.map((d) => [d.id, d]),
) as Record<ModuleId, ModuleDefinition>;

export const MODULE_LIST: readonly ModuleDefinition[] = DEFINITIONS;

export function isModuleId(value: string): value is ModuleId {
  return Object.prototype.hasOwnProperty.call(MODULES, value);
}

export function isPlanModule(value: string): value is PlanModuleId {
  return (PLAN_MODULE_IDS as readonly string[]).includes(value);
}

/** Modules platform staff can put in a plan now: everything not merely planned or retired. */
export const PLAN_CHOICES: readonly PlanModuleId[] = PLAN_MODULE_IDS.filter((id) => {
  const stage = MODULES[id].stage;
  return stage !== "planned" && stage !== "retired";
});

/** Modules a school can ask to add on its own (and platform staff can add as an add-on). */
export const ADD_ON_CHOICES: readonly PlanModuleId[] = PLAN_CHOICES.filter(
  (id) => MODULES[id].purchasable && MODULES[id].stage !== "deprecated",
);

/** The module whose own pages a staff path is under, if any: `/s/{slug}/attendance/...` is attendance. */
export function moduleForSchoolPath(path: string, slug: string): PlanModuleId | null {
  const prefix = `/s/${slug}/`;
  if (!path.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const rest = path.slice(prefix.length).split(/[?#]/)[0]!.replace(/\/+$/, "");
  let best: { id: PlanModuleId; length: number } | null = null;
  for (const id of PLAN_MODULE_IDS)
    for (const route of MODULES[id].routes)
      if ((rest === route || rest.startsWith(`${route}/`)) && (!best || route.length > best.length))
        best = { id, length: route.length };
  return best?.id ?? null;
}

// ---- Resolving a school's modules (ENT-01), pure so it can be tested on its own -------------------------

export const ENTITLEMENT_SOURCES = ["addon", "trial", "promotion", "enterprise"] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

export const ENTITLEMENT_SOURCE_LABELS: Record<EntitlementSource | "plan" | "core", string> = {
  core: "Every plan",
  plan: "Plan",
  addon: "Add-on",
  trial: "Trial",
  promotion: "Promotion",
  enterprise: "Agreement",
};

/** One add-on, trial, promotion or agreement row for a school (school_modules). */
export interface ModuleGrant {
  module: string;
  source: EntitlementSource;
  startsOn: string;
  endsOn: string | null;
  /** The school-local date it was ended early, if it was. */
  endedOn: string | null;
}

export interface ModuleState {
  state: "active" | "read_only" | "off";
  /** Why the school has it (or last had it). */
  source: EntitlementSource | "plan" | "core" | null;
  /** The last day it is (or was) included, when that is known. */
  endsOn: string | null;
  /** Off only because the module is not released to this school yet. */
  unreleased: boolean;
  /** Off (or read-only) because a module it needs is not active. */
  missing: ModuleId[];
}

export interface ResolveInput {
  /** The plan's modules; null when the school has no plan row (made outside onboarding): every module. */
  planModules: readonly string[] | null;
  grants: readonly ModuleGrant[];
  /** Modules this school has release access to (pilot, internal testing). */
  releaseAccess: readonly string[];
  isDemo: boolean;
  /** Production deployments never reach modules still in development. */
  production: boolean;
  /** Today in the school's time zone (YYYY-MM-DD). */
  today: string;
  /** Days a module stays read-only after an add-on, trial or promotion ends (platform setting). */
  readOnlyDays: number;
  /** For tests: a different registry. */
  modules?: Readonly<Record<string, ModuleDefinition>>;
}

export function isReleasedTo(
  stage: ModuleStage,
  school: { hasAccess: boolean; isDemo: boolean; production: boolean },
): boolean {
  switch (stage) {
    case "general":
    case "deprecated":
      return true;
    case "pilot":
    case "ready":
    case "internal_testing":
      return school.hasAccess || school.isDemo || !school.production;
    case "in_development":
      return !school.production;
    case "planned":
    case "retired":
      return false;
  }
}

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** The last day a grant covers: its end date, or the day before it was ended early. */
function lastDay(grant: ModuleGrant): string | null {
  const early = grant.endedOn ? addDays(grant.endedOn, -1) : null;
  if (early && grant.endsOn) return early < grant.endsOn ? early : grant.endsOn;
  return early ?? grant.endsOn;
}

/**
 * Each module's state for one school: core modules always; others when released to the school (demo schools
 * reach modules in internal testing and pilot), included in its plan (no plan row: every module, as before) or
 * covered today by an add-on, trial, promotion or agreement, and every module they need is active.
 * A module whose grant has ended is read-only for `readOnlyDays` when the module allows it (R4 onwards).
 */
export function resolveModules(input: ResolveInput): Record<string, ModuleState> {
  const registry = input.modules ?? MODULES;
  const access = new Set(input.releaseAccess);
  const states: Record<string, ModuleState> = {};
  for (const def of Object.values(registry)) {
    if (def.availability === "core") {
      states[def.id] = { state: "active", source: "core", endsOn: null, unreleased: false, missing: [] };
      continue;
    }
    const released = isReleasedTo(def.stage, {
      hasAccess: access.has(def.id),
      isDemo: input.isDemo,
      production: input.production,
    });
    let state: ModuleState["state"] = "off";
    let source: ModuleState["source"] = null;
    let endsOn: string | null = null;
    if (def.everyPlan || input.planModules === null || input.planModules.includes(def.id)) {
      state = "active";
      source = "plan";
    }
    if (state === "off") {
      const grants = input.grants.filter((g) => g.module === def.id);
      const current = grants.find((g) => {
        const last = lastDay(g);
        return g.startsOn <= input.today && (last === null || last >= input.today);
      });
      if (current) {
        state = "active";
        source = current.source;
        endsOn = lastDay(current);
      } else if (def.readOnlyAfterEnd) {
        // The most recently ended grant, if its read-only window covers today.
        const ended = grants
          .map((g) => ({ g, last: lastDay(g) }))
          .filter((x): x is { g: ModuleGrant; last: string } => x.last !== null && x.last < input.today)
          .sort((a, b) => (a.last < b.last ? 1 : -1))[0];
        if (ended && addDays(ended.last, input.readOnlyDays) >= input.today) {
          state = "read_only";
          source = ended.g.source;
          endsOn = ended.last;
        }
      }
    }
    states[def.id] = {
      state: released ? state : "off",
      source,
      endsOn,
      unreleased: !released && state !== "off",
      missing: [],
    };
  }
  // A module is no more available than every module it needs (MOD-03), repeated until nothing changes.
  for (let changed = true; changed;) {
    changed = false;
    for (const def of Object.values(registry)) {
      const s = states[def.id]!;
      if (s.state === "off") continue;
      const missing = def.requires.filter((r) => states[r]?.state !== "active");
      if (missing.length === 0) continue;
      const downgraded = missing.some((r) => states[r]?.state === "read_only") ? "read_only" : "off";
      if (s.state !== downgraded || s.missing.join() !== missing.join()) {
        if (s.state === "active" || downgraded === "off") s.state = downgraded;
        s.missing = missing;
        changed = true;
      }
    }
  }
  return states;
}

/** The modules active for a school, from `resolveModules`. */
export function activeModules(states: Record<string, ModuleState>): PlanModuleId[] {
  return PLAN_MODULE_IDS.filter((id) => states[id]?.state === "active");
}

export function readOnlyModules(states: Record<string, ModuleState>): PlanModuleId[] {
  return PLAN_MODULE_IDS.filter((id) => states[id]?.state === "read_only");
}

/** A school's add-on as an invoice sees it. */
export interface PricedGrant {
  module: PlanModuleId;
  source: EntitlementSource;
  startsOn: string;
  endsOn: string | null;
  endedAt: Date | null;
  pricePesewas: number | null;
  priceUnit: "flat" | "per_student" | null;
}

/**
 * Invoice lines for the add-ons a school has on a date (SUB-09): one per priced add-on, trial or agreement that
 * covers the date; a per-student price counts the school's active students that day.
 */
export function addOnInvoiceLines(
  grants: readonly PricedGrant[],
  on: string,
  activeStudents: number,
): { description: string; quantity: number; unitPesewas: number }[] {
  return grants
    .filter(
      (g) =>
        g.endedAt === null &&
        g.startsOn <= on &&
        (g.endsOn === null || g.endsOn >= on) &&
        g.pricePesewas !== null &&
        g.pricePesewas > 0,
    )
    .map((g) => ({
      description:
        g.priceUnit === "per_student"
          ? `${MODULES[g.module].name} (${ENTITLEMENT_SOURCE_LABELS[g.source].toLowerCase()}), per active student`
          : `${MODULES[g.module].name} (${ENTITLEMENT_SOURCE_LABELS[g.source].toLowerCase()})`,
      quantity: g.priceUnit === "per_student" ? activeStudents : 1,
      unitPesewas: g.pricePesewas!,
    }))
    .filter((l) => l.quantity > 0);
}

/** Dependencies a module needs that a list of modules lacks (for granting, MOD-03). */
export function missingDependencies(id: ModuleId, have: readonly string[]): ModuleId[] {
  return MODULES[id].requires.filter(
    (r) => MODULES[r].availability !== "core" && !have.includes(r),
  ) as ModuleId[];
}
