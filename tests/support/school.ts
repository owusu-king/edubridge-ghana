import { randomUUID } from "node:crypto";
import { createAcademicYear, listAcademicYears, setCurrentTerm } from "@/server/academics/calendar";
import { createClass, listLevelsWithClasses, setupDefaultLevels } from "@/server/academics/classes";
import type { Role } from "@/server/authz/permissions";
import type { Stage } from "@/lib/curricula";
import type { Database } from "@/server/db/client";
import { withTenant } from "@/server/db/context";
import { campuses } from "@/server/db/schema";
import { billTerm } from "@/server/fees/ledger";
import { recordPayment } from "@/server/fees/payments";
import { listFeeItems, saveLevelFees, setupFeeItems } from "@/server/fees/structure";
import { createStudent } from "@/server/students/service";
import { resolveTenantContext, type TenantContext } from "@/server/tenancy/service";
import { todayIn } from "@/lib/format";
import { addMember, createTenant, createUser } from "./fixtures";

/**
 * A one-campus school with a current term, Basic 1 to JHS 3, one class per level asked for, and tuition charged
 * per level. Members are added by role; `ctx(role)` gives each one's context. Shared by the finance tests.
 */
export async function billedSchool(
  conn: { app: Database; owner: Database },
  options: { roles?: Role[]; tuition?: string; levels?: string[]; stages?: Stage[] } = {},
) {
  const tenant = await createTenant(conn.owner);
  const members = new Map<Role, string>();
  for (const role of ["owner", ...(options.roles ?? [])] as Role[]) {
    const user = await createUser(conn.owner, `${role} user`);
    await addMember(conn.owner, tenant.id, user.id, [role]);
    members.set(role, user.id);
  }
  const ctx = async (role: Role = "owner") =>
    (await resolveTenantContext(conn.app, tenant.slug, members.get(role)!)) as TenantContext;
  const owner = await ctx("owner");
  const [campus] = await withTenant(
    conn.owner,
    { tenantId: tenant.id, userId: members.get("owner")! },
    (tx) => tx.insert(campuses).values({ tenantId: tenant.id, name: "Main" }).returning(),
  );
  await setupDefaultLevels(conn.app, owner, { stages: options.stages ?? ["primary", "jhs"] });
  await createAcademicYear(conn.app, owner, {
    name: "2026/2027",
    terms: [{ name: "Term 1", startsOn: "2026-09-08", endsOn: "2026-12-18" }],
  });
  const termId = (await listAcademicYears(conn.app, owner))[0]!.terms[0]!.id;
  await setCurrentTerm(conn.app, owner, termId);
  const allLevels = await listLevelsWithClasses(conn.app, owner);
  await setupFeeItems(conn.app, owner, { names: ["Tuition"] });
  const [tuition] = await listFeeItems(conn.app, owner);
  const classes: Record<string, string> = {};
  for (const name of options.levels ?? ["Basic 1"]) {
    const level = allLevels.find((l) => l.name === name)!;
    classes[name] = await createClass(conn.app, owner, {
      levelId: level.id,
      campusId: campus!.id,
      name: `${name}A`,
    });
    await saveLevelFees(conn.app, owner, termId, level.id, {
      amounts: { [tuition!.id]: options.tuition ?? "1000" },
      classAmounts: {},
    });
  }
  const today = todayIn(tenant.timezone);
  return {
    tenant,
    owner,
    ctx,
    campusId: campus!.id,
    termId,
    classes,
    today,
    userId: (role: Role = "owner") => members.get(role)!,
    addStudent: (firstName: string, lastName: string, level = options.levels?.[0] ?? "Basic 1") =>
      createStudent(conn.app, owner, { firstName, lastName, sex: "female", classId: classes[level] }),
    bill: () => billTerm(conn.app, owner, termId),
    pay: (
      studentId: string,
      amount: string,
      extra: Record<string, unknown> = {},
      as: TenantContext = owner,
    ) =>
      recordPayment(conn.app, as, {
        studentId,
        amount,
        method: "cash",
        paidOn: todayIn(tenant.timezone),
        idempotencyKey: randomUUID(),
        ...extra,
      }),
  };
}
