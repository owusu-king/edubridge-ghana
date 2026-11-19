import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Transaction } from "../db/client";
import {
  campuses,
  classes,
  enrolments,
  guardians,
  levels,
  studentGuardians,
  students,
  terms,
} from "../db/schema";
import { DomainError } from "../errors";

/**
 * Who a message, event or consent form is for: the whole school, a campus, a level or a class (by this
 * term's classes). Shared by announcements, events and consent forms so they reach families the same way.
 */

export const AUDIENCES = ["school", "level", "class", "campus"] as const;
export type Audience = (typeof AUDIENCES)[number];

export const audienceFields = {
  audience: z.enum(AUDIENCES, { message: "Choose who it is for." }),
  audienceId: z.preprocess((v) => (v === "" || v === undefined ? null : v), z.string().uuid().nullable()),
};

/** The audience exists at this school (and "school" has no id, the others one). */
export async function assertAudience(
  tx: Transaction,
  tenantId: string,
  audience: Audience,
  audienceId: string | null,
): Promise<void> {
  if ((audience === "school") !== (audienceId === null))
    throw new DomainError("audience_invalid", "Choose who it is for.", "audience");
  if (!audienceId) return;
  const table = audience === "level" ? levels : audience === "class" ? classes : campuses;
  const [found] = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.tenantId, tenantId), eq(table.id, audienceId)));
  if (!found) throw new DomainError("audience_invalid", "Choose who it is for.", "audience");
}

/** Labels for audiences ("The whole school", "Basic 4", "East campus"), keyed "audience:id". */
export async function audienceLabels(
  tx: Transaction,
  tenantId: string,
  rows: readonly { audience: Audience; audienceId: string | null }[],
): Promise<(row: { audience: Audience; audienceId: string | null }) => string> {
  const ids = [...new Set(rows.map((r) => r.audienceId).filter((v): v is string => v !== null))];
  const names = new Map<string, string>();
  if (ids.length)
    for (const t of [levels, classes, campuses] as const)
      for (const n of await tx
        .select({ id: t.id, name: t.name })
        .from(t)
        .where(and(eq(t.tenantId, tenantId), inArray(t.id, ids))))
        names.set(n.id, t === campuses ? `${n.name} campus` : n.name);
  return (r) => (r.audience === "school" ? "The whole school" : (names.get(r.audienceId!) ?? "A group"));
}

/** A guardian number with one of their active children's class, level and campus this term. */
export interface Reach {
  phone: string;
  studentId: string;
  levelId: string | null;
  classId: string | null;
  campusId: string | null;
}

/**
 * Guardian numbers of active students, with each student's class, level and campus this term. Guardians the
 * school stopped using the parent view (e.g. a custody change), and those who turned announcements off,
 * are left out of messages; what was sent still shows in their parent view.
 */
export async function familyReach(tx: Transaction, tenantId: string): Promise<Reach[]> {
  return tx
    .select({
      phone: guardians.phone,
      studentId: students.id,
      levelId: classes.levelId,
      classId: classes.id,
      campusId: classes.campusId,
    })
    .from(studentGuardians)
    .innerJoin(guardians, eq(guardians.id, studentGuardians.guardianId))
    .innerJoin(students, and(eq(students.id, studentGuardians.studentId), eq(students.status, "active")))
    .leftJoin(
      enrolments,
      and(
        eq(enrolments.studentId, students.id),
        sql`${enrolments.termId} = (select id from ${terms} where ${terms.tenantId} = ${tenantId} and ${terms.isCurrent})`,
      ),
    )
    .leftJoin(classes, eq(classes.id, enrolments.classId))
    .where(
      and(
        eq(studentGuardians.tenantId, tenantId),
        sql`${guardians.phone} is not null`,
        isNull(guardians.portalBlockedAt),
        // The guardian (or the school for them) can turn announcements off (PAR-05).
        eq(studentGuardians.receivesMessages, true),
      ),
    ) as Promise<Reach[]>;
}

/** A student (or guardian row) is in the audience, by this term's class. */
export function inAudience(
  r: { levelId: string | null; classId: string | null; campusId: string | null },
  audience: Audience,
  id: string | null,
): boolean {
  return (
    audience === "school" ||
    (audience === "level" && r.levelId === id) ||
    (audience === "class" && r.classId === id) ||
    (audience === "campus" && r.campusId === id)
  );
}

/** Distinct guardian numbers in an audience. */
export const phonesFor = (rows: readonly Reach[], audience: Audience, id: string | null) => [
  ...new Set(rows.filter((r) => inAudience(r, audience, id)).map((r) => r.phone)),
];

/** The ids of levels, classes and campuses a set of reach rows is in, for "is this for me?" queries. */
export function audienceKeys(
  rows: readonly { levelId: string | null; classId: string | null; campusId: string | null }[],
) {
  const ids = (key: "levelId" | "classId" | "campusId") => [
    ...new Set(rows.map((r) => r[key]).filter((v): v is string => v !== null)),
  ];
  return { levelIds: ids("levelId"), classIds: ids("classId"), campusIds: ids("campusId") };
}
