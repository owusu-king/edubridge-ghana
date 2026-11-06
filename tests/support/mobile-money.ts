import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createAcademicYear, listAcademicYears, setCurrentTerm } from "@/server/academics/calendar";
import { createClass, listLevelsWithClasses, setupDefaultLevels } from "@/server/academics/classes";
import { withTenant } from "@/server/db/context";
import { auditEvents, campuses, membershipCampuses, payments } from "@/server/db/schema";
import { getStudentAccount } from "@/server/fees/ledger";
import { listFeeItems, saveLevelFees, setupFeeItems } from "@/server/fees/structure";
import { mockProvider } from "@/server/mobile-money/mock";
import type { CollectionStatus, MobileMoneyProvider } from "@/server/mobile-money/provider";
import { ProviderError } from "@/server/mobile-money/provider";
import { requestMobileMoneyPayment, type MobileMoneyDeps } from "@/server/mobile-money/requests";
import { createStudent } from "@/server/students/service";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { addMember, connect, createTenant, createUser } from "./fixtures";

/**
 * Shared set-up for Mobile Money tests: a school with Main and East campuses, finance staff (one limited
 * to East), a current term and Basic 4 fees of GH₵1,000.
 */
export const conn = connect();

export const mock: MobileMoneyDeps = { provider: mockProvider() };
/** Mock numbers: the payer approves, except for these endings (see src/server/mobile-money/mock.ts). */
export const APPROVES = "024 123 4567";
export const DECLINES = "024 555 1111";
export const NO_ANSWER = "024 555 2222";
export const WRONG_AMOUNT = "024 555 3333";
export const NOT_REGISTERED = "024 555 4444";

export async function school() {
  const tenant = await createTenant(conn.owner);
  const people = {
    owner: await createUser(conn.owner, "Proprietor"),
    head: await createUser(conn.owner, "Head"),
    bursar: await createUser(conn.owner, "Akosua Accountant"),
    teacher: await createUser(conn.owner, "Teacher"),
    eastBursar: await createUser(conn.owner, "East Accountant"),
  };
  await addMember(conn.owner, tenant.id, people.owner.id, ["owner"]);
  await addMember(conn.owner, tenant.id, people.head.id, ["headteacher"]);
  await addMember(conn.owner, tenant.id, people.bursar.id, ["bursar"]);
  await addMember(conn.owner, tenant.id, people.teacher.id, ["teacher"]);
  const eastM = await addMember(conn.owner, tenant.id, people.eastBursar.id, ["bursar"]);
  const [main, east] = await withTenant(
    conn.owner,
    { tenantId: tenant.id, userId: people.owner.id },
    async (tx) => {
      const rows = await tx
        .insert(campuses)
        .values([
          { tenantId: tenant.id, name: "Main" },
          { tenantId: tenant.id, name: "East" },
        ])
        .returning();
      await tx
        .insert(membershipCampuses)
        .values({ tenantId: tenant.id, membershipId: eastM.id, campusId: rows[1]!.id });
      return rows;
    },
  );
  const ctx = async (id: string) => (await resolveTenantContext(conn.app, tenant.slug, id)) as TenantContext;
  const owner = await ctx(people.owner.id);
  const bursar = await ctx(people.bursar.id);
  await setupDefaultLevels(conn.app, owner, { stages: ["primary"] });
  await createAcademicYear(conn.app, owner, {
    name: "2026/2027",
    terms: [{ name: "Term 1", startsOn: "2026-09-08", endsOn: "2026-12-18" }],
  });
  const [y] = await listAcademicYears(conn.app, owner);
  await setCurrentTerm(conn.app, owner, y!.terms[0]!.id);
  const basic4 = (await listLevelsWithClasses(conn.app, owner)).find((l) => l.name === "Basic 4")!;
  const classA = await createClass(conn.app, owner, {
    levelId: basic4.id,
    campusId: main!.id,
    name: "Basic 4A",
  });
  const classB = await createClass(conn.app, owner, {
    levelId: basic4.id,
    campusId: east!.id,
    name: "Basic 4B",
  });
  await setupFeeItems(conn.app, bursar, { names: ["Tuition"] });
  const [tuition] = await listFeeItems(conn.app, bursar);
  await saveLevelFees(conn.app, bursar, y!.terms[0]!.id, basic4.id, {
    amounts: { [tuition!.id]: "1000" },
    classAmounts: {},
  });
  const add = (firstName: string, classId: string) =>
    createStudent(conn.app, owner, { firstName, lastName: "Mensah", sex: "female", classId });
  return {
    tenant,
    owner,
    bursar,
    head: await ctx(people.head.id),
    teacher: await ctx(people.teacher.id),
    eastBursar: await ctx(people.eastBursar.id),
    termId: y!.terms[0]!.id,
    classA,
    classB,
    add,
  };
}

export type School = Awaited<ReturnType<typeof school>>;

export const ask = (
  s: School,
  studentId: string,
  phone: string,
  amount = "400",
  extra: Record<string, unknown> = {},
  deps: MobileMoneyDeps = mock,
  ctx = s.bursar,
) =>
  requestMobileMoneyPayment(
    conn.app,
    ctx,
    { studentId, amount, phone, network: "mtn", idempotencyKey: randomUUID(), ...extra },
    deps,
  );

export const balance = async (s: School, id: string) =>
  (await getStudentAccount(conn.app, s.bursar, id))!.balancePesewas;

export const paymentsFor = (s: School, studentId: string) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
    tx
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, s.tenant.id), eq(payments.studentId, studentId))),
  );

export const auditActions = (s: School, requestId: string) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, async (tx) =>
    (
      await tx
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(and(eq(auditEvents.tenantId, s.tenant.id), eq(auditEvents.entityId, requestId)))
    ).map((r) => r.action),
  );

/** A provider whose answer the test controls. */
export function scripted(initial: CollectionStatus = { state: "pending" }, name = "scripted") {
  const state = {
    status: initial,
    fail: null as ProviderError | null,
    statusFail: null as ProviderError | null,
  };
  const provider: MobileMoneyProvider = {
    name,
    testMode: true,
    async requestPayment() {
      if (state.fail) throw state.fail;
      return { providerReference: `SCRIPTED-${randomUUID()}` };
    },
    async getStatus() {
      if (state.statusFail) throw state.statusFail;
      return state.status;
    },
    verifyCallback() {
      return null;
    },
  };
  return { state, deps: { provider } satisfies MobileMoneyDeps };
}
