import "server-only";
import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import { copyNumber, normalizeIsbn, type ReservationStatus } from "../../lib/library";
import { allowed, assertAllowed } from "../authz/permissions";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { libraryCopies, libraryTitles } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import {
  audit,
  blank,
  nextNumber,
  optionalText,
  optionalWholeNumber,
  requiredText,
  scopeOf,
  UUID,
  wholeNumber,
} from "../inventory/common";
import type { TenantContext } from "../tenancy/service";
import { borrowerNames } from "./borrowers";

/**
 * The library catalogue (R4-7 LIB-01a, LIB-01b): titles, and copies numbered from a per-school counter (B0001).
 * Titles are archived and copies withdrawn, never deleted (database).
 */

const assertView = (ctx: TenantContext) => {
  if (!allowed(ctx, "library.manage")) assertAllowed(ctx, "library.view");
};

export interface TitleSummary {
  id: string;
  title: string;
  author: string | null;
  isbn: string | null;
  category: string | null;
  status: "active" | "archived";
  copies: number;
  out: number;
  waiting: number;
}

/** Titles with how many copies are in and out, optionally matching a search (title, author or ISBN). */
export async function listTitles(
  database: Database,
  ctx: TenantContext,
  query = "",
): Promise<TitleSummary[]> {
  assertView(ctx);
  const q = query.trim().slice(0, 100);
  const isbn = normalizeIsbn(q) ?? q.replace(/[\s-]/g, "");
  return withTenant(database, scopeOf(ctx), (tx) =>
    tx
      .select({
        id: libraryTitles.id,
        title: libraryTitles.title,
        author: libraryTitles.author,
        isbn: libraryTitles.isbn,
        category: libraryTitles.category,
        status: libraryTitles.status,
        copies: sql<number>`(select count(*)::int from library_copies c where c.title_id = library_titles.id and c.status = 'active')`,
        out: sql<number>`(select count(*)::int from library_loans l join library_copies c on c.id = l.copy_id where c.title_id = library_titles.id and l.returned_at is null and l.lost_at is null)`,
        waiting: sql<number>`(select count(*)::int from library_reservations r where r.title_id = library_titles.id and r.status = 'waiting')`,
      })
      .from(libraryTitles)
      .where(
        and(
          eq(libraryTitles.tenantId, ctx.tenant.id),
          q
            ? or(
                ilike(libraryTitles.title, `%${q}%`),
                ilike(libraryTitles.author, `%${q}%`),
                isbn ? eq(libraryTitles.isbn, isbn) : undefined,
              )
            : undefined,
        ),
      )
      .orderBy(asc(libraryTitles.status), asc(libraryTitles.title))
      .limit(300),
  );
}

export interface CopyDetail {
  id: string;
  number: string;
  shelf: string | null;
  status: "active" | "withdrawn";
  withdrawnReason: string | null;
  loan: { id: string; borrower: string; dueOn: string } | null;
  heldFor: string | null;
}

export interface TitleDetail extends TitleSummary {
  publisher: string | null;
  publishedYear: number | null;
  copyList: CopyDetail[];
  queue: { id: string; borrower: string; status: ReservationStatus; reservedAt: Date; copy: string | null }[];
}

export async function getTitle(
  database: Database,
  ctx: TenantContext,
  titleId: string,
): Promise<TitleDetail | null> {
  assertView(ctx);
  if (!UUID.safeParse(titleId).success) return null;
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [t] = await tx
      .select()
      .from(libraryTitles)
      .where(and(eq(libraryTitles.tenantId, ctx.tenant.id), eq(libraryTitles.id, titleId)));
    if (!t) return null;
    const copies = await tx.execute<{
      id: string;
      number: string;
      shelf: string | null;
      status: "active" | "withdrawn";
      withdrawn_reason: string | null;
      loan_id: string | null;
      due_on: string | null;
      student_id: string | null;
      membership_id: string | null;
    }>(sql`
      select c.id, c.number, c.shelf, c.status, c.withdrawn_reason, l.id as loan_id, l.due_on::text as due_on,
             l.student_id, l.membership_id
      from library_copies c
      left join library_loans l on l.copy_id = c.id and l.returned_at is null and l.lost_at is null
      where c.tenant_id = ${ctx.tenant.id} and c.title_id = ${titleId}
      order by c.status, c.number`);
    const queue = await tx.execute<{
      id: string;
      status: ReservationStatus;
      reserved_at: Date;
      student_id: string | null;
      membership_id: string | null;
      copy: string | null;
    }>(sql`
      select r.id, r.status, r.reserved_at, r.student_id, r.membership_id, c.number as copy
      from library_reservations r left join library_copies c on c.id = r.held_copy_id
      where r.tenant_id = ${ctx.tenant.id} and r.title_id = ${titleId} and r.status in ('waiting', 'ready')
      order by r.reserved_at`);
    const names = await borrowerNames(tx, ctx.tenant.id, [
      ...copies.rows.map((c) => ({ studentId: c.student_id, membershipId: c.membership_id })),
      ...queue.rows.map((r) => ({ studentId: r.student_id, membershipId: r.membership_id })),
    ]);
    const name = (studentId: string | null, membershipId: string | null) =>
      names.get(studentId ?? membershipId ?? "") ?? "Unknown";
    const heldBy = new Map(
      queue.rows
        .filter((r) => r.status === "ready" && r.copy)
        .map((r) => [r.copy!, name(r.student_id, r.membership_id)]),
    );
    const copyList: CopyDetail[] = copies.rows.map((c) => ({
      id: c.id,
      number: c.number,
      shelf: c.shelf,
      status: c.status,
      withdrawnReason: c.withdrawn_reason,
      loan: c.loan_id
        ? { id: c.loan_id, borrower: name(c.student_id, c.membership_id), dueOn: c.due_on! }
        : null,
      heldFor: heldBy.get(c.number) ?? null,
    }));
    const active = copyList.filter((c) => c.status === "active");
    return {
      id: t.id,
      title: t.title,
      author: t.author,
      isbn: t.isbn,
      category: t.category,
      status: t.status,
      publisher: t.publisher,
      publishedYear: t.publishedYear,
      copies: active.length,
      out: active.filter((c) => c.loan).length,
      waiting: queue.rows.filter((r) => r.status === "waiting").length,
      copyList,
      queue: queue.rows.map((r) => ({
        id: r.id,
        borrower: name(r.student_id, r.membership_id),
        status: r.status,
        reservedAt: new Date(r.reserved_at),
        copy: r.copy,
      })),
    };
  });
}

const titleSchema = z.object({
  title: requiredText(1, 200, "Enter the title."),
  author: optionalText(200),
  isbn: z.preprocess(blank, z.string().nullable().optional()).transform((v, c) => {
    if (!v) return null;
    const isbn = normalizeIsbn(v);
    if (!isbn) {
      c.addIssue({ code: "custom", message: "Check the ISBN: 10 or 13 digits, as printed on the book." });
      return z.NEVER;
    }
    return isbn;
  }),
  publisher: optionalText(120),
  publishedYear: optionalWholeNumber(1450, 2200),
  category: optionalText(60),
});

/** Adds a title (with copies, if asked), or changes one when `titleId` is given. */
export async function saveTitle(
  database: Database,
  ctx: TenantContext,
  input: Record<string, unknown>,
  titleId?: string,
): Promise<string> {
  assertAllowed(ctx, "library.manage");
  const data = titleSchema.parse(input);
  const copies = titleId ? 0 : wholeNumber(0, 50, "Use 0 to 50 copies.").safeParse(input.copies ?? "0");
  if (copies !== 0 && !copies.success) throw new DomainError("invalid", "Use 0 to 50 copies.", "copies");
  const values = {
    title: data.title,
    author: data.author ?? null,
    isbn: data.isbn,
    publisher: data.publisher ?? null,
    publishedYear: data.publishedYear,
    category: data.category ?? null,
  };
  return withTenant(database, scopeOf(ctx), async (tx) => {
    if (titleId) {
      if (!UUID.safeParse(titleId).success) throw new DomainError("not_found", "Title not found.");
      const [row] = await tx
        .update(libraryTitles)
        .set({ ...values, updatedAt: new Date() })
        .where(and(eq(libraryTitles.tenantId, ctx.tenant.id), eq(libraryTitles.id, titleId)))
        .returning({ id: libraryTitles.id });
      if (!row) throw new DomainError("not_found", "Title not found.");
      await audit(tx, ctx, "library.title_changed", "library_title", row.id, { title: data.title });
      return row.id;
    }
    const [row] = await tx
      .insert(libraryTitles)
      .values({ tenantId: ctx.tenant.id, ...values })
      .returning({ id: libraryTitles.id });
    const count = copies === 0 ? 0 : copies.data;
    for (let i = 0; i < count; i++)
      await tx.insert(libraryCopies).values({
        tenantId: ctx.tenant.id,
        titleId: row!.id,
        number: copyNumber(await nextNumber(tx, ctx.tenant.id, "library_copy")),
        shelf: blank(input.shelf) ? String(input.shelf).trim().slice(0, 60) : null,
        createdByUserId: ctx.userId,
      });
    await audit(tx, ctx, "library.title_added", "library_title", row!.id, {
      title: data.title,
      copies: count,
    });
    return row!.id;
  }).catch((error: unknown) => {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION)
      throw new DomainError("isbn_taken", "A title with this ISBN is already in the catalogue.", "isbn");
    throw error;
  });
}

export async function setTitleArchived(
  database: Database,
  ctx: TenantContext,
  titleId: string,
  archived: boolean,
): Promise<void> {
  assertAllowed(ctx, "library.manage");
  if (!UUID.safeParse(titleId).success) throw new DomainError("not_found", "Title not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [row] = await tx
      .update(libraryTitles)
      .set({ status: archived ? "archived" : "active", updatedAt: new Date() })
      .where(and(eq(libraryTitles.tenantId, ctx.tenant.id), eq(libraryTitles.id, titleId)))
      .returning({ id: libraryTitles.id });
    if (!row) throw new DomainError("not_found", "Title not found.");
    await audit(
      tx,
      ctx,
      archived ? "library.title_archived" : "library.title_restored",
      "library_title",
      row.id,
    );
  });
}

/** Adds copies of a title, each with the next number (B0001). */
export async function addCopies(
  database: Database,
  ctx: TenantContext,
  titleId: string,
  input: Record<string, unknown>,
): Promise<string[]> {
  assertAllowed(ctx, "library.manage");
  const data = z
    .object({ count: wholeNumber(1, 50, "Use 1 to 50 copies."), shelf: optionalText(60) })
    .parse(input);
  if (!UUID.safeParse(titleId).success) throw new DomainError("not_found", "Title not found.");
  return withTenant(database, scopeOf(ctx), async (tx) => {
    const [title] = await tx
      .select({ id: libraryTitles.id, status: libraryTitles.status })
      .from(libraryTitles)
      .where(and(eq(libraryTitles.tenantId, ctx.tenant.id), eq(libraryTitles.id, titleId)));
    if (!title) throw new DomainError("not_found", "Title not found.");
    if (title.status !== "active")
      throw new DomainError("archived", "This title is archived. Restore it first.");
    const numbers: string[] = [];
    for (let i = 0; i < data.count; i++) {
      const number = copyNumber(await nextNumber(tx, ctx.tenant.id, "library_copy"));
      await tx.insert(libraryCopies).values({
        tenantId: ctx.tenant.id,
        titleId,
        number,
        shelf: data.shelf ?? null,
        createdByUserId: ctx.userId,
      });
      numbers.push(number);
    }
    await audit(tx, ctx, "library.copies_added", "library_title", titleId, { copies: numbers });
    return numbers;
  });
}

/** Withdraws a copy (damaged, discarded), once, with a reason. A copy on loan is returned or marked lost first. */
export async function withdrawCopy(
  database: Database,
  ctx: TenantContext,
  copyId: string,
  reasonInput: unknown,
): Promise<void> {
  assertAllowed(ctx, "library.manage");
  const reason = requiredText(3, 200, "Say why, e.g. damaged beyond repair.").safeParse(reasonInput);
  if (!reason.success)
    throw new DomainError("reason_required", "Say why, e.g. damaged beyond repair.", "reason");
  if (!UUID.safeParse(copyId).success) throw new DomainError("not_found", "Copy not found.");
  await withTenant(database, scopeOf(ctx), async (tx) => {
    const [copy] = await tx
      .select({
        id: libraryCopies.id,
        number: libraryCopies.number,
        titleId: libraryCopies.titleId,
        status: libraryCopies.status,
      })
      .from(libraryCopies)
      .where(and(eq(libraryCopies.tenantId, ctx.tenant.id), eq(libraryCopies.id, copyId)))
      .for("update");
    if (!copy || copy.status !== "active") throw new DomainError("not_found", "Copy not found.");
    const [busy] = await tx
      .execute<{ loan: boolean; held: boolean }>(
        sql`
      select exists (select 1 from library_loans where copy_id = ${copyId} and returned_at is null and lost_at is null) as loan,
             exists (select 1 from library_reservations where held_copy_id = ${copyId} and status = 'ready') as held`,
      )
      .then((r) => r.rows);
    if (busy?.loan)
      throw new DomainError("on_loan", "This copy is on loan. Return it or mark it lost first.");
    if (busy?.held)
      throw new DomainError("held", "This copy is held for a reservation. Cancel the reservation first.");
    await tx
      .update(libraryCopies)
      .set({ status: "withdrawn", withdrawnAt: new Date(), withdrawnReason: reason.data })
      .where(eq(libraryCopies.id, copyId));
    await audit(tx, ctx, "library.copy_withdrawn", "library_title", copy.titleId, {
      copy: copy.number,
      reason: reason.data,
    });
  });
}
