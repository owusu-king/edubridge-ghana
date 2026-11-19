import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { HOUSE_KINDS, type HouseKind } from "../../lib/boarding";
import { assertAllowed, can } from "../authz/permissions";
import type { Database, Queryable, Transaction } from "../db/client";
import { withTenant } from "../db/context";
import {
  boardingBeds,
  boardingHouseStaff,
  boardingHouses,
  boardingRooms,
  boardingSettings,
  feeItems,
  memberships,
  terms,
  users,
} from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import { audit, blank, requiredText, scopeOf, UUID, wholeNumber } from "../inventory/common";
import { fullName } from "../students/service";
import type { TenantContext } from "../tenancy/service";

/**
 * Boarding houses (R4-8 BRD-01a, BRD-01b): houses, rooms, beds and house staff. Nothing is deleted. House staff
 * (a school grant) see only the houses they look after; the office and leadership see every house.
 */

export async function currentTermId(tx: Queryable, tenantId: string): Promise<string | null> {
  const [term] = await tx
    .select({ id: terms.id })
    .from(terms)
    .where(and(eq(terms.tenantId, tenantId), eq(terms.isCurrent, true)));
  return term?.id ?? null;
}

/** Houses this member may see: every house for the roles that view boarding; their own for house staff. */
export async function visibleHouseIds(tx: Queryable, ctx: TenantContext): Promise<string[] | null> {
  if (can(ctx.roles, "boarding.view") || ctx.support) return null;
  const rows = await tx
    .select({ houseId: boardingHouseStaff.houseId })
    .from(boardingHouseStaff)
    .innerJoin(memberships, eq(memberships.id, boardingHouseStaff.membershipId))
    .where(
      and(
        eq(boardingHouseStaff.tenantId, ctx.tenant.id),
        eq(memberships.userId, ctx.userId),
        isNull(boardingHouseStaff.endedAt),
      ),
    );
  return rows.map((r) => r.houseId);
}

export interface HouseSummary {
  id: string;
  name: string;
  kind: HouseKind;
  status: "active" | "archived";
  beds: number;
  boarders: number;
  out: number;
  staff: string[];
}

export async function listHouses(database: Database, ctx: TenantContext): Promise<HouseSummary[]> {
  assertAllowed(ctx, "boarding.view");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const visible = await visibleHouseIds(tx, ctx);
    const termId = await currentTermId(tx, ctx.tenant.id);
    const rows = await tx.execute<{
      id: string;
      name: string;
      kind: HouseKind;
      status: "active" | "archived";
      beds: number;
      boarders: number;
      out: number;
      staff: string[] | null;
    }>(sql`
      select h.id, h.name, h.kind, h.status,
        (select count(*)::int from boarding_beds b join boarding_rooms r on r.id = b.room_id
          where r.house_id = h.id and b.status = 'active' and r.status = 'active') as beds,
        (select count(*)::int from boarding_assignments a join boarding_beds b on b.id = a.bed_id
          join boarding_rooms r on r.id = b.room_id
          where r.house_id = h.id and a.term_id = ${termId} and a.ended_at is null) as boarders,
        (select count(*)::int from boarding_exeats e where e.house_id = h.id and e.back_at is null) as out,
        (select array_agg(u.name order by u.name) from boarding_house_staff s
          join memberships m on m.id = s.membership_id join users u on u.id = m.user_id
          where s.house_id = h.id and s.ended_at is null) as staff
      from boarding_houses h
      where h.tenant_id = ${ctx.tenant.id}
      order by h.status, h.name`);
    return rows.rows
      .filter((h) => visible === null || visible.includes(h.id))
      .map((h) => ({ ...h, staff: h.staff ?? [] }));
  });
}

export interface BedDetail {
  id: string;
  label: string;
  status: "active" | "archived";
  boarder: { assignmentId: string; studentId: string; name: string; className: string | null } | null;
}

export interface HouseDetail extends HouseSummary {
  rooms: { id: string; name: string; status: "active" | "archived"; beds: BedDetail[] }[];
  staffList: { id: string; membershipId: string; name: string; since: Date }[];
}

export async function getHouse(
  database: Database,
  ctx: TenantContext,
  houseId: string,
): Promise<HouseDetail | null> {
  assertAllowed(ctx, "boarding.view");
  if (!UUID.safeParse(houseId).success) return null;
  const [summary] = (await listHouses(database, ctx)).filter((h) => h.id === houseId);
  if (!summary) return null;
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const termId = await currentTermId(tx, ctx.tenant.id);
    const rows = await tx.execute<{
      room_id: string;
      room_name: string;
      room_status: "active" | "archived";
      bed_id: string | null;
      label: string | null;
      bed_status: "active" | "archived" | null;
      assignment_id: string | null;
      student_id: string | null;
      first_name: string | null;
      other_names: string | null;
      last_name: string | null;
      class_name: string | null;
    }>(sql`
      select r.id as room_id, r.name as room_name, r.status as room_status, b.id as bed_id, b.label,
             b.status as bed_status, a.id as assignment_id, s.id as student_id, s.first_name, s.other_names,
             s.last_name, c.name as class_name
      from boarding_rooms r
      left join boarding_beds b on b.room_id = r.id
      left join boarding_assignments a on a.bed_id = b.id and a.term_id = ${termId} and a.ended_at is null
      left join students s on s.id = a.student_id
      left join enrolments e on e.student_id = s.id and e.term_id = ${termId}
      left join classes c on c.id = e.class_id
      where r.tenant_id = ${ctx.tenant.id} and r.house_id = ${houseId}
      order by r.status, r.name, b.status, length(b.label), b.label`);
    const rooms = new Map<string, HouseDetail["rooms"][number]>();
    for (const r of rows.rows) {
      const room = rooms.get(r.room_id) ?? {
        id: r.room_id,
        name: r.room_name,
        status: r.room_status,
        beds: [],
      };
      rooms.set(r.room_id, room);
      if (r.bed_id)
        room.beds.push({
          id: r.bed_id,
          label: r.label!,
          status: r.bed_status!,
          boarder: r.assignment_id
            ? {
                assignmentId: r.assignment_id,
                studentId: r.student_id!,
                name: fullName({
                  firstName: r.first_name!,
                  otherNames: r.other_names,
                  lastName: r.last_name!,
                }),
                className: r.class_name,
              }
            : null,
        });
    }
    const staffList = await tx
      .select({
        id: boardingHouseStaff.id,
        membershipId: boardingHouseStaff.membershipId,
        name: users.name,
        since: boardingHouseStaff.addedAt,
      })
      .from(boardingHouseStaff)
      .innerJoin(memberships, eq(memberships.id, boardingHouseStaff.membershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(boardingHouseStaff.tenantId, ctx.tenant.id),
          eq(boardingHouseStaff.houseId, houseId),
          isNull(boardingHouseStaff.endedAt),
        ),
      )
      .orderBy(asc(users.name));
    return { ...summary, rooms: [...rooms.values()], staffList };
  });
}

const houseSchema = z.object({
  name: requiredText(1, 60, "Name the house."),
  kind: z.enum(HOUSE_KINDS, { message: "Choose boys, girls or mixed." }),
});

/** Adds a house, or renames it and changes who it is for when `houseId` is given. */
export async function saveHouse(
  database: Database,
  ctx: TenantContext,
  input: Record<string, unknown>,
  houseId?: string,
): Promise<string> {
  assertAllowed(ctx, "boarding.manage");
  const data = houseSchema.parse(input);
  return withTenant(database, scopeOf(ctx), async (tx) => {
    if (houseId) {
      if (!UUID.safeParse(houseId).success) throw new DomainError("not_found", "House not found.");
      const [row] = await tx
        .update(boardingHouses)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(boardingHouses.tenantId, ctx.tenant.id), eq(boardingHouses.id, houseId)))
        .returning({ id: boardingHouses.id });
      if (!row) throw new DomainError("not_found", "House not found.");
      await audit(tx, ctx, "boarding.house_changed", "boarding_house", row.id, data);
      return row.id;
    }
    const [row] = await tx
      .insert(boardingHouses)
      .values({ tenantId: ctx.tenant.id, ...data })
      .returning({ id: boardingHouses.id });
    await audit(tx, ctx, "boarding.house_added", "boarding_house", row!.id, data);
    return row!.id;
  }).catch((error: unknown) => {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
      throw new DomainError("name_taken", "There is already a house with this name.", "name");
    throw error;
  });
}

async function boardersIn(tx: Transaction, ctx: TenantContext, where: ReturnType<typeof sql>) {
  const termId = await currentTermId(tx, ctx.tenant.id);
  if (!termId) return 0;
  const [row] = await tx
    .execute<{ n: number }>(
      sql`
    select count(*)::int as n from boarding_assignments a
    join boarding_beds b on b.id = a.bed_id join boarding_rooms r on r.id = b.room_id
    where a.tenant_id = ${ctx.tenant.id} and a.term_id = ${termId} and a.ended_at is null and ${where}`,
    )
    .then((r) => r.rows);
  return row!.n;
}

export async function setHouseArchived(
  database: Database,
  ctx: TenantContext,
  houseId: string,
  archived: boolean,
) {
  assertAllowed(ctx, "boarding.manage");
  if (!UUID.safeParse(houseId).success) throw new DomainError("not_found", "House not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    if (archived && (await boardersIn(tx, ctx, sql`r.house_id = ${houseId}`)) > 0)
      throw new DomainError("occupied", "Boarders sleep in this house this term. Move them first.");
    const [row] = await tx
      .update(boardingHouses)
      .set({ status: archived ? "archived" : "active", updatedAt: new Date() })
      .where(and(eq(boardingHouses.tenantId, ctx.tenant.id), eq(boardingHouses.id, houseId)))
      .returning({ id: boardingHouses.id });
    if (!row) throw new DomainError("not_found", "House not found.");
    await audit(
      tx,
      ctx,
      archived ? "boarding.house_archived" : "boarding.house_restored",
      "boarding_house",
      row.id,
    );
  });
}

/** Adds a room with a number of beds (Bed 1, Bed 2, …), or more beds to a room. */
export async function addRoom(
  database: Database,
  ctx: TenantContext,
  houseId: string,
  input: Record<string, unknown>,
): Promise<string> {
  assertAllowed(ctx, "boarding.manage");
  const data = z
    .object({
      name: requiredText(1, 60, "Name the room, e.g. Dormitory A."),
      beds: wholeNumber(1, 60, "Use 1 to 60 beds."),
    })
    .parse(input);
  if (!UUID.safeParse(houseId).success) throw new DomainError("not_found", "House not found.");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [house] = await tx
      .select({ status: boardingHouses.status })
      .from(boardingHouses)
      .where(and(eq(boardingHouses.tenantId, ctx.tenant.id), eq(boardingHouses.id, houseId)));
    if (!house) throw new DomainError("not_found", "House not found.");
    if (house.status !== "active")
      throw new DomainError("archived", "This house is archived. Restore it first.");
    const [room] = await tx
      .insert(boardingRooms)
      .values({ tenantId: ctx.tenant.id, houseId, name: data.name })
      .returning({ id: boardingRooms.id })
      .catch((error: unknown) => {
        if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
          throw new DomainError("name_taken", "This house already has a room with this name.", "name");
        throw error;
      });
    await tx.insert(boardingBeds).values(
      Array.from({ length: data.beds }, (_, i) => ({
        tenantId: ctx.tenant.id,
        roomId: room!.id,
        label: `Bed ${i + 1}`,
      })),
    );
    await audit(tx, ctx, "boarding.room_added", "boarding_house", houseId, {
      room: data.name,
      beds: data.beds,
    });
    return room!.id;
  });
}

export async function addBeds(database: Database, ctx: TenantContext, roomId: string, countInput: unknown) {
  assertAllowed(ctx, "boarding.manage");
  const count = wholeNumber(1, 60, "Use 1 to 60 beds.").safeParse(countInput);
  if (!count.success) throw new DomainError("invalid", "Use 1 to 60 beds.", "beds");
  if (!UUID.safeParse(roomId).success) throw new DomainError("not_found", "Room not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [room] = await tx
      .select({ id: boardingRooms.id, houseId: boardingRooms.houseId, name: boardingRooms.name })
      .from(boardingRooms)
      .where(and(eq(boardingRooms.tenantId, ctx.tenant.id), eq(boardingRooms.id, roomId)))
      .for("update");
    if (!room) throw new DomainError("not_found", "Room not found.");
    const [n] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(boardingBeds)
      .where(eq(boardingBeds.roomId, roomId));
    await tx.insert(boardingBeds).values(
      Array.from({ length: count.data }, (_, i) => ({
        tenantId: ctx.tenant.id,
        roomId,
        label: `Bed ${n!.n + i + 1}`,
      })),
    );
    await audit(tx, ctx, "boarding.beds_added", "boarding_house", room.houseId, {
      room: room.name,
      beds: count.data,
    });
  });
}

/** Takes a bed out of use (broken, room changed); refused while a boarder sleeps in it this term. */
export async function archiveBed(database: Database, ctx: TenantContext, bedId: string) {
  assertAllowed(ctx, "boarding.manage");
  if (!UUID.safeParse(bedId).success) throw new DomainError("not_found", "Bed not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    if ((await boardersIn(tx, ctx, sql`b.id = ${bedId}`)) > 0)
      throw new DomainError("occupied", "A boarder sleeps in this bed this term. Move them first.");
    const [bed] = await tx
      .update(boardingBeds)
      .set({ status: "archived" })
      .where(and(eq(boardingBeds.tenantId, ctx.tenant.id), eq(boardingBeds.id, bedId)))
      .returning({ roomId: boardingBeds.roomId, label: boardingBeds.label });
    if (!bed) throw new DomainError("not_found", "Bed not found.");
    await audit(tx, ctx, "boarding.bed_archived", "boarding_bed", bedId, { bed: bed.label });
  });
}

/** Members of staff who can look after a house. */
export async function listStaffOptions(database: Database, ctx: TenantContext) {
  assertAllowed(ctx, "boarding.manage");
  return withTenant(database, scopeOf(ctx), (tx) =>
    tx
      .select({ id: memberships.id, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.tenantId, ctx.tenant.id),
          eq(memberships.status, "active"),
          sql`${memberships.roles} && ARRAY['owner','headteacher','admin','bursar','teacher']::text[]`,
        ),
      )
      .orderBy(asc(users.name)),
  );
}

export async function appointHouseStaff(
  database: Database,
  ctx: TenantContext,
  houseId: string,
  membershipId: unknown,
) {
  assertAllowed(ctx, "boarding.manage");
  const id = UUID.safeParse(membershipId);
  if (!id.success || !UUID.safeParse(houseId).success)
    throw new DomainError("not_found", "Choose a member of staff.", "membershipId");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [member] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, ctx.tenant.id),
          eq(memberships.id, id.data),
          eq(memberships.status, "active"),
        ),
      );
    if (!member) throw new DomainError("not_found", "Choose an active member of staff.", "membershipId");
    const inserted = await tx
      .insert(boardingHouseStaff)
      .values({ tenantId: ctx.tenant.id, houseId, membershipId: id.data, addedByUserId: ctx.userId })
      .onConflictDoNothing()
      .returning({ id: boardingHouseStaff.id });
    if (!inserted.length) return;
    await audit(tx, ctx, "boarding.staff_appointed", "boarding_house", houseId, { membershipId: id.data });
  });
}

export async function endHouseStaff(database: Database, ctx: TenantContext, staffId: string) {
  assertAllowed(ctx, "boarding.manage");
  if (!UUID.safeParse(staffId).success) throw new DomainError("not_found", "Not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .update(boardingHouseStaff)
      .set({ endedAt: new Date(), endedByUserId: ctx.userId })
      .where(
        and(
          eq(boardingHouseStaff.tenantId, ctx.tenant.id),
          eq(boardingHouseStaff.id, staffId),
          isNull(boardingHouseStaff.endedAt),
        ),
      )
      .returning({ houseId: boardingHouseStaff.houseId, membershipId: boardingHouseStaff.membershipId });
    if (!row) throw new DomainError("not_found", "Not found.");
    await audit(tx, ctx, "boarding.staff_ended", "boarding_house", row.houseId, {
      membershipId: row.membershipId,
    });
  });
}

// ——— Fees (BRD-02) ———

export async function readBoardingFeeItem(tx: Queryable, tenantId: string): Promise<string | null> {
  const [row] = await tx
    .select({ feeItemId: boardingSettings.feeItemId })
    .from(boardingSettings)
    .where(eq(boardingSettings.tenantId, tenantId));
  return row?.feeItemId ?? null;
}

export async function getBoardingFeeSettings(database: Database, ctx: TenantContext) {
  assertAllowed(ctx, "boarding.view");
  return withTenant(database, scopeOf(ctx), async (tx) => ({
    feeItemId: await readBoardingFeeItem(tx, ctx.tenant.id),
    optionalItems: await tx
      .select({ id: feeItems.id, name: feeItems.name })
      .from(feeItems)
      .where(
        and(eq(feeItems.tenantId, ctx.tenant.id), eq(feeItems.optional, true), eq(feeItems.status, "active")),
      )
      .orderBy(asc(feeItems.sequence)),
  }));
}

/** Which optional fee item boarding is billed as; for those who manage fees. */
export async function setBoardingFeeItem(database: Database, ctx: TenantContext, input: unknown) {
  assertAllowed(ctx, "fees.manage");
  assertAllowed(ctx, "boarding.view");
  const parsed = z.preprocess(blank, UUID.nullable()).safeParse(input ?? null);
  if (!parsed.success) throw new DomainError("not_found", "Choose an optional fee item.", "feeItemId");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    let name: string | null = null;
    if (parsed.data) {
      const [item] = await tx
        .select({ name: feeItems.name })
        .from(feeItems)
        .where(
          and(
            eq(feeItems.tenantId, ctx.tenant.id),
            eq(feeItems.id, parsed.data),
            eq(feeItems.optional, true),
            eq(feeItems.status, "active"),
          ),
        );
      if (!item) throw new DomainError("not_optional", "Choose an optional fee item.", "feeItemId");
      name = item.name;
    }
    const values = { feeItemId: parsed.data, updatedByUserId: ctx.userId, updatedAt: new Date() };
    await tx
      .insert(boardingSettings)
      .values({ tenantId: ctx.tenant.id, ...values })
      .onConflictDoUpdate({ target: boardingSettings.tenantId, set: values });
    await audit(tx, ctx, "boarding.fee_item_set", "tenant", ctx.tenant.id, { item: name });
  });
}
