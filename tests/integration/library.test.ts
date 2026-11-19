import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { ForbiddenError } from "@/server/authz/permissions";
import { withTenant } from "@/server/db/context";
import { ledgerEntries, libraryLoans } from "@/server/db/schema";
import { exportDataset } from "@/server/export/datasets";
import { getStudentAccount } from "@/server/fees/ledger";
import { addCopies, getTitle, listTitles, saveTitle } from "@/server/library/catalogue";
import {
  cancelReservation,
  findOpenLoan,
  lendCopy,
  listBorrowerOptions,
  listOpenLoans,
  markLost,
  readParentLibrary,
  renewLoan,
  reserveTitle,
  returnLoan,
  saveFineRules,
  saveLoanRules,
} from "@/server/library/loans";
import { conn, school, type School } from "../support/mobile-money";

afterAll(() => conn.close());

/** Backdates a loan's due date, as if time had passed (test set-up only, through the owner connection). */
const dueDaysAgo = (s: School, loanId: string, days: number) =>
  withTenant(conn.owner, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
    tx
      .update(libraryLoans)
      .set({ dueOn: sql`current_date - ${days}::int` })
      .where(eq(libraryLoans.id, loanId)),
  );

const raw = (s: School, statement: ReturnType<typeof sql>) =>
  withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) => tx.execute(statement));

async function setup() {
  const s = await school();
  const kwame = (await s.add("Kwame", s.classA)).id;
  const esi = (await s.add("Esi", s.classA)).id;
  const ama = (await s.add("Ama", s.classA)).id;
  const borrowers = await listBorrowerOptions(conn.app, s.owner);
  const teacher = borrowers.find((b) => b.name === "Teacher")!.key;
  return {
    s,
    kwame: `student:${kwame}`,
    esi: `student:${esi}`,
    ama: `student:${ama}`,
    kwameId: kwame,
    teacher,
  };
}

describe("catalogue (LIB-01a, LIB-01b)", () => {
  it("adds books with numbered copies, checks ISBNs, and lets staff search", async () => {
    const { s } = await setup();
    const achebe = await saveTitle(conn.app, s.owner, {
      title: "Things Fall Apart",
      author: "Chinua Achebe",
      isbn: "978-0-385-47454-2",
      category: "Fiction",
      copies: "2",
      shelf: "Fiction A",
    });
    await expect(saveTitle(conn.app, s.owner, { title: "Copy", isbn: "9780385474542" })).rejects.toThrow(
      "already in the catalogue",
    );
    await expect(saveTitle(conn.app, s.owner, { title: "Typo", isbn: "9780385474543" })).rejects.toThrow(
      "Check the ISBN",
    );
    await expect(saveTitle(conn.app, s.teacher, { title: "Mine" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await addCopies(conn.app, s.head, achebe, { count: "1" })).toEqual(["B0003"]);

    // Teachers search the catalogue, by author or ISBN.
    expect((await listTitles(conn.app, s.teacher, "achebe")).map((t) => [t.title, t.copies, t.out])).toEqual([
      ["Things Fall Apart", 3, 0],
    ]);
    expect(await listTitles(conn.app, s.teacher, "978 0385 474542")).toHaveLength(1);
    expect((await getTitle(conn.app, s.teacher, achebe))!.copyList.map((c) => c.number)).toEqual([
      "B0001",
      "B0002",
      "B0003",
    ]);
    await expect(raw(s, sql`delete from library_copies`)).rejects.toThrow();
    await expect(raw(s, sql`update library_copies set number = 'B9999'`)).rejects.toThrow();
    const other = await school();
    expect(await listTitles(conn.app, other.owner)).toEqual([]);
  });
});

describe("loans (LIB-01c, LIB-01d)", () => {
  it("lends a copy once at a time, within the limit, renews it, and returns it once", async () => {
    const { s, kwame, esi, teacher } = await setup();
    await saveTitle(conn.app, s.owner, { title: "Weep Not, Child", copies: "2" });
    await saveLoanRules(conn.app, s.owner, { loanDays: "14", maxLoans: "1" });

    const lent = await lendCopy(conn.app, s.owner, { copy: "b0001", borrower: kwame });
    expect(lent).toMatchObject({ title: "Weep Not, Child", borrower: "Kwame Mensah" });
    await expect(lendCopy(conn.app, s.owner, { copy: "B0001", borrower: esi })).rejects.toThrow(
      "already on loan",
    );
    await expect(lendCopy(conn.app, s.owner, { copy: "B0002", borrower: kwame })).rejects.toThrow(
      "already has 1 book",
    );
    await expect(lendCopy(conn.app, s.owner, { copy: "B0404", borrower: esi })).rejects.toThrow(
      "No copy B0404",
    );
    await expect(lendCopy(conn.app, s.teacher, { copy: "B0002", borrower: esi })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await lendCopy(conn.app, s.owner, { copy: "B0002", borrower: teacher });

    // The database allows one open loan per copy, whatever the service does.
    const loanId = await findOpenLoan(conn.app, s.owner, "B0001");
    await expect(
      raw(
        s,
        sql`insert into library_loans (tenant_id, copy_id, student_id, loaned_by_user_id, due_on)
            select tenant_id, copy_id, student_id, loaned_by_user_id, due_on from library_loans where id = ${loanId}`,
      ),
    ).rejects.toThrow();

    const loans = await listOpenLoans(conn.app, s.teacher);
    expect(loans.map((l) => [l.copy, l.borrower, l.isStudent, l.daysLate])).toEqual([
      ["B0001", "Kwame Mensah", true, 0],
      ["B0002", "Teacher", false, 0],
    ]);
    await renewLoan(conn.app, s.owner, loanId);
    const back = await returnLoan(conn.app, s.owner, loanId);
    expect(back).toMatchObject({ copy: "B0001", daysLate: 0, fineMinor: 0, heldFor: null });
    await expect(returnLoan(conn.app, s.owner, loanId)).rejects.toThrow("already closed");
    await expect(
      raw(s, sql`update library_loans set due_on = current_date where id = ${loanId}`),
    ).rejects.toThrow();
    await expect(raw(s, sql`delete from library_loans`)).rejects.toThrow();

    // A lost book closes the loan and withdraws the copy.
    const staffLoan = await findOpenLoan(conn.app, s.owner, "B0002");
    await markLost(conn.app, s.owner, staffLoan, "Left on the bus");
    await expect(lendCopy(conn.app, s.owner, { copy: "B0002", borrower: esi })).rejects.toThrow(
      "No copy B0002",
    );
    expect((await exportDataset(conn.app, s.owner, "library_loans")).rows).toBe(2);
  });
});

describe("fines (LIB-02)", () => {
  it("charges a late student once, through the ledger, and never fines staff", async () => {
    const { s, kwame, kwameId, teacher } = await setup();
    await saveTitle(conn.app, s.owner, { title: "Anowa", copies: "2" });
    await expect(
      saveFineRules(conn.app, s.head, { finesEnabled: "on", finePerDay: "0.50" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveFineRules(conn.app, s.bursar, { finesEnabled: "on" })).rejects.toThrow("fine per day");
    await saveFineRules(conn.app, s.bursar, { finesEnabled: "on", finePerDay: "0.50", fineCap: "2.00" });

    await lendCopy(conn.app, s.owner, { copy: "B0001", borrower: kwame });
    await lendCopy(conn.app, s.owner, { copy: "B0002", borrower: teacher });
    const kwameLoan = await findOpenLoan(conn.app, s.owner, "B0001");
    const staffLoan = await findOpenLoan(conn.app, s.owner, "B0002");
    await dueDaysAgo(s, kwameLoan, 5);
    await dueDaysAgo(s, staffLoan, 5);
    expect((await listOpenLoans(conn.app, s.owner)).map((l) => l.daysLate)).toEqual([5, 5]);
    await expect(renewLoan(conn.app, s.owner, kwameLoan)).rejects.toThrow("5 days late");

    const before = (await getStudentAccount(conn.app, s.bursar, kwameId))!.balancePesewas;
    // 5 days at 0.50 is 2.50, capped at 2.00.
    expect(await returnLoan(conn.app, s.owner, kwameLoan)).toMatchObject({ daysLate: 5, fineMinor: 200 });
    expect((await getStudentAccount(conn.app, s.bursar, kwameId))!.balancePesewas).toBe(before + 200);
    const [charge] = await withTenant(conn.app, { tenantId: s.tenant.id, userId: s.owner.userId }, (tx) =>
      tx
        .select()
        .from(ledgerEntries)
        .where(
          and(eq(ledgerEntries.tenantId, s.tenant.id), eq(ledgerEntries.billingKey, `library:${kwameLoan}`)),
        ),
    );
    expect(charge).toMatchObject({
      kind: "charge",
      amountPesewas: 200,
      description: "Library fine: Anowa, 5 days late",
    });
    expect(await returnLoan(conn.app, s.owner, staffLoan)).toMatchObject({ daysLate: 5, fineMinor: 0 });
  });
});

describe("reservations (LIB-01e)", () => {
  it("holds a returned copy for the first in the queue, and passes it on when they cancel", async () => {
    const { s, kwame, esi, ama, kwameId } = await setup();
    const title = await saveTitle(conn.app, s.owner, { title: "Our Sister Killjoy", copies: "1" });
    await expect(reserveTitle(conn.app, s.owner, title, esi)).rejects.toThrow("A copy is in");
    await lendCopy(conn.app, s.owner, { copy: "B0001", borrower: kwame });
    await reserveTitle(conn.app, s.owner, title, esi);
    await reserveTitle(conn.app, s.owner, title, ama);
    await expect(reserveTitle(conn.app, s.owner, title, esi)).rejects.toThrow("already waiting");
    await expect(
      renewLoan(conn.app, s.owner, await findOpenLoan(conn.app, s.owner, "B0001")),
    ).rejects.toThrow("Someone is waiting");

    const back = await returnLoan(conn.app, s.owner, await findOpenLoan(conn.app, s.owner, "B0001"));
    expect(back.heldFor).toBe("Esi Mensah");
    await expect(lendCopy(conn.app, s.owner, { copy: "B0001", borrower: ama })).rejects.toThrow(
      "held for Esi Mensah",
    );

    // Esi cancels: the copy is now held for Ama, who collects it.
    const queue = (await getTitle(conn.app, s.owner, title))!.queue;
    expect(queue.map((r) => [r.borrower, r.status])).toEqual([
      ["Esi Mensah", "ready"],
      ["Ama Mensah", "waiting"],
    ]);
    await cancelReservation(conn.app, s.owner, queue[0]!.id);
    expect((await getTitle(conn.app, s.owner, title))!.copyList[0]!.heldFor).toBe("Ama Mensah");
    await lendCopy(conn.app, s.owner, { copy: "B0001", borrower: ama });
    expect((await getTitle(conn.app, s.owner, title))!.queue).toEqual([]);
    await expect(raw(s, sql`update library_reservations set status = 'waiting'`)).rejects.toThrow();

    // The parent view lists a child's books.
    await withTenant(conn.app, { tenantId: s.tenant.id, userId: "" }, async (tx) => {
      expect(await readParentLibrary(tx, s.tenant.id, kwameId, "2026-11-17")).toEqual([]);
    });
  });
});
