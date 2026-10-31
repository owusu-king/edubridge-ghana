import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withUser } from "@/server/db/context";
import { auditEvents, memberships, tenants } from "@/server/db/schema";
import { addMember, connect, createTenant, createUser } from "../support/fixtures";

const conn = connect();

/** Drizzle wraps driver errors; the PostgreSQL error is the cause. 42501 = insufficient_privilege. */
const isPermissionDenied = (e: unknown) => (e as { cause?: { code?: string } }).cause?.code === "42501";
afterAll(() => conn.close());

let schoolA: Awaited<ReturnType<typeof createTenant>>;
let schoolB: Awaited<ReturnType<typeof createTenant>>;
let adminA: Awaited<ReturnType<typeof createUser>>;
let adminB: Awaited<ReturnType<typeof createUser>>;
let sharedParent: Awaited<ReturnType<typeof createUser>>;

beforeAll(async () => {
  schoolA = await createTenant(conn.owner, "School A");
  schoolB = await createTenant(conn.owner, "School B");
  adminA = await createUser(conn.owner, "Admin A");
  adminB = await createUser(conn.owner, "Admin B");
  sharedParent = await createUser(conn.owner, "Parent in both");
  await addMember(conn.owner, schoolA.id, adminA.id, ["admin"]);
  await addMember(conn.owner, schoolB.id, adminB.id, ["admin"]);
  await addMember(conn.owner, schoolA.id, sharedParent.id, ["parent"]);
  await addMember(conn.owner, schoolB.id, sharedParent.id, ["parent"]);
});

describe("row-level security", () => {
  it("runs the application as a role that cannot bypass RLS", async () => {
    const result = await conn.app.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(result.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("returns no tenant rows when no tenant context is set", async () => {
    const rows = await conn.app.select().from(memberships);
    expect(rows).toHaveLength(0);
  });

  it("only returns the current tenant's memberships", async () => {
    const rows = await withTenant(conn.app, { tenantId: schoolA.id, userId: adminA.id }, (tx) =>
      tx.select().from(memberships),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === schoolA.id)).toBe(true);
  });

  it("lets a user list their own memberships across schools, and nothing else", async () => {
    const rows = await withUser(conn.app, sharedParent.id, (tx) => tx.select().from(memberships));
    expect(rows.map((r) => r.tenantId).sort()).toEqual([schoolA.id, schoolB.id].sort());
    expect(rows.every((r) => r.userId === sharedParent.id)).toBe(true);
  });

  it("rejects inserting rows into another tenant", async () => {
    const outsider = await createUser(conn.owner);
    await expect(
      withTenant(conn.app, { tenantId: schoolA.id, userId: adminA.id }, (tx) =>
        tx.insert(memberships).values({ tenantId: schoolB.id, userId: outsider.id, roles: ["admin"] }),
      ),
    ).rejects.toSatisfy(isPermissionDenied);
  });

  it("cannot update another tenant's rows", async () => {
    const result = await withTenant(conn.app, { tenantId: schoolA.id, userId: adminA.id }, (tx) =>
      tx
        .update(memberships)
        .set({ status: "suspended" })
        .where(sql`${memberships.tenantId} = ${schoolB.id}`),
    );
    expect(result.rowCount).toBe(0);
  });

  it("cannot update another school's profile", async () => {
    const result = await withTenant(conn.app, { tenantId: schoolA.id, userId: adminA.id }, (tx) =>
      tx
        .update(tenants)
        .set({ name: "Hijacked" })
        .where(sql`${tenants.id} = ${schoolB.id}`),
    );
    expect(result.rowCount).toBe(0);
  });

  it("does not leak tenant context between pooled transactions", async () => {
    await withTenant(conn.app, { tenantId: schoolA.id, userId: adminA.id }, (tx) =>
      tx.select().from(memberships),
    );
    const result = await conn.app.execute<{ t: string | null }>(sql`select app_current_tenant_id() as t`);
    expect(result.rows[0]?.t).toBeNull();
  });

  it("keeps audit events append-only", async () => {
    await withTenant(conn.app, { tenantId: schoolA.id, userId: adminA.id }, (tx) =>
      tx.insert(auditEvents).values({ tenantId: schoolA.id, action: "test.event", entityType: "test" }),
    );
    await expect(
      withTenant(conn.app, { tenantId: schoolA.id, userId: adminA.id }, (tx) =>
        tx.update(auditEvents).set({ action: "tampered" }),
      ),
    ).rejects.toSatisfy(isPermissionDenied);
    await expect(
      withTenant(conn.app, { tenantId: schoolA.id, userId: adminA.id }, (tx) => tx.delete(auditEvents)),
    ).rejects.toSatisfy(isPermissionDenied);
  });

  it("enforces ENABLE and FORCE row-level security on every table with a tenant_id column", async () => {
    const result = await conn.owner.execute<{ table: string; enabled: boolean; forced: boolean }>(sql`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind = 'r'
    `);
    expect(result.rows.length).toBeGreaterThan(0);
    const unprotected = result.rows.filter((r) => !r.enabled || !r.forced).map((r) => r.table);
    expect(unprotected).toEqual([]);
  });
});
