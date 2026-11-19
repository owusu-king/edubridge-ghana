import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Queryable, Transaction } from "../db/client";
import { classes, enrolments, memberships, students, terms, users } from "../db/schema";
import { DomainError } from "../errors";
import { fullName } from "../students/service";
import type { TenantContext } from "../tenancy/service";

/**
 * Library borrowers (R4-7): students at the school this term, and members of staff. Pickers send
 * "student:<id>" or "member:<id>"; a loan or reservation stores exactly one of the two.
 */

export interface Borrower {
  studentId: string | null;
  membershipId: string | null;
  name: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who a borrower key names, if they can borrow now (an active student or an active member of staff). */
export async function resolveBorrower(tx: Transaction, ctx: TenantContext, key: unknown): Promise<Borrower> {
  const [kind, id] = typeof key === "string" ? key.split(":") : [];
  const refuse = () => new DomainError("not_found", "Choose a student or a member of staff.", "borrower");
  if (!id || !UUID.test(id)) throw refuse();
  if (kind === "student") {
    const [s] = await tx
      .select()
      .from(students)
      .where(and(eq(students.tenantId, ctx.tenant.id), eq(students.id, id), eq(students.status, "active")));
    if (!s) throw refuse();
    return { studentId: s.id, membershipId: null, name: fullName(s) };
  }
  if (kind === "member") {
    const [m] = await tx
      .select({ id: memberships.id, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.tenantId, ctx.tenant.id),
          eq(memberships.id, id),
          eq(memberships.status, "active"),
          sql`${memberships.roles} && ARRAY['owner','headteacher','admin','bursar','teacher']::text[]`,
        ),
      );
    if (!m) throw refuse();
    return { studentId: null, membershipId: m.id, name: m.name };
  }
  throw refuse();
}

/** Names of borrowers, by student or membership id. */
export async function borrowerNames(
  tx: Queryable,
  tenantId: string,
  refs: { studentId: string | null; membershipId: string | null }[],
): Promise<Map<string, string>> {
  const studentIds = [...new Set(refs.map((r) => r.studentId).filter((v): v is string => !!v))];
  const memberIds = [...new Set(refs.map((r) => r.membershipId).filter((v): v is string => !!v))];
  const names = new Map<string, string>();
  if (studentIds.length)
    for (const s of await tx
      .select()
      .from(students)
      .where(and(eq(students.tenantId, tenantId), inArray(students.id, studentIds))))
      names.set(s.id, fullName(s));
  if (memberIds.length)
    for (const m of await tx
      .select({ id: memberships.id, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.tenantId, tenantId), inArray(memberships.id, memberIds))))
      names.set(m.id, m.name);
  return names;
}

/** Everyone who can borrow, for pickers: students by this term's class, then staff. */
export async function readBorrowerOptions(
  tx: Queryable,
  tenantId: string,
): Promise<{ key: string; name: string; group: string }[]> {
  const pupils = await tx
    .select({ s: students, className: classes.name })
    .from(students)
    .leftJoin(
      enrolments,
      and(
        eq(enrolments.studentId, students.id),
        sql`${enrolments.termId} = (select id from ${terms} where tenant_id = ${tenantId} and is_current)`,
      ),
    )
    .leftJoin(classes, eq(classes.id, enrolments.classId))
    .where(and(eq(students.tenantId, tenantId), eq(students.status, "active")))
    .orderBy(asc(classes.name), asc(students.firstName), asc(students.lastName));
  const staff = await tx
    .select({ id: memberships.id, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        eq(memberships.status, "active"),
        sql`${memberships.roles} && ARRAY['owner','headteacher','admin','bursar','teacher']::text[]`,
      ),
    )
    .orderBy(asc(users.name));
  return [
    ...pupils.map((p) => ({
      key: `student:${p.s.id}`,
      name: fullName(p.s),
      group: p.className ?? "No class this term",
    })),
    ...staff.map((m) => ({ key: `member:${m.id}`, name: m.name, group: "Staff" })),
  ];
}
