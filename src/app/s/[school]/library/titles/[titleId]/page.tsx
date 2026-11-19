import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/ui/action-forms";
import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getTitle } from "@/server/library/catalogue";
import { listBorrowerOptions } from "@/server/library/loans";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { RESERVATION_STATUS_LABELS } from "@/lib/library";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import {
  addCopiesAction,
  cancelReservationAction,
  reserveAction,
  saveTitleAction,
  setTitleArchivedAction,
  withdrawCopyAction,
} from "../../actions";
import { AddCopiesDialog, ReasonDialog, ReserveDialog, TitleDialog } from "../../library-controls";

export const metadata: Metadata = { title: "Library · Book" };

/** One book: its copies and where each is, and the queue of people waiting for it (LIB-01b, LIB-01e). */
export default async function TitlePage({
  params,
}: {
  params: Promise<{ school: string; titleId: string }>;
}) {
  const { school, titleId } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "library.view")) notFound();
  const t = await getTitle(db(), ctx, titleId);
  if (!t) notFound();
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const manage = allowed(ctx, "library.manage");
  const active = t.status === "active";
  const free = t.copyList.filter((c) => c.status === "active" && !c.loan && !c.heldFor).length;
  const borrowers =
    manage && active && free === 0 && t.copies > 0 ? await listBorrowerOptions(db(), ctx) : [];

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            href={schoolPath(slug, "library") as Route}
            className="text-sm text-ink-3 hover:text-ink hover:underline"
          >
            Catalogue
          </Link>
          <h2 className="font-display text-xl font-medium tracking-tight text-ink">{t.title}</h2>
          <p className="mt-1 text-base text-ink-2">
            {[t.author, t.publisher, t.publishedYear, t.isbn && `ISBN ${t.isbn}`, t.category]
              .filter(Boolean)
              .join(" · ") || " "}
          </p>
          {!active && <StatusText tone="neutral">Archived</StatusText>}
        </div>
        {manage && (
          <div className="flex flex-wrap items-center gap-2">
            {active && borrowers.length > 0 && (
              <ReserveDialog action={reserveAction.bind(null, slug, t.id)} borrowers={borrowers} />
            )}
            {active && <AddCopiesDialog action={addCopiesAction.bind(null, slug, t.id)} />}
            {active && <TitleDialog action={saveTitleAction.bind(null, slug, t.id)} title={t} />}
            <ActionButton
              action={setTitleArchivedAction.bind(null, slug, t.id, active)}
              label={active ? "Archive" : "Restore"}
              ariaLabel={`${active ? "Archive" : "Restore"} ${t.title}`}
            />
          </div>
        )}
      </div>

      <Section
        title="Copies"
        description={`${free} of ${t.copies} in${t.waiting ? `, ${t.waiting} waiting` : ""}.`}
      >
        {t.copyList.length === 0 ? (
          <p className="text-base text-ink-3">No copies yet.</p>
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Copies of {t.title}</caption>
              <THead>
                <tr>
                  <TH>Copy</TH>
                  <TH className="hidden sm:table-cell">Shelf</TH>
                  <TH>Where</TH>
                  {manage && (
                    <TH>
                      <span className="sr-only">Withdraw</span>
                    </TH>
                  )}
                </tr>
              </THead>
              <TBody>
                {t.copyList.map((c) => (
                  <TR key={c.id}>
                    <TD className="font-medium text-ink tabular-nums">{c.number}</TD>
                    <TD className="hidden sm:table-cell">{c.shelf ?? "—"}</TD>
                    <TD>
                      {c.status === "withdrawn" ? (
                        <span className="text-ink-3">Withdrawn: {c.withdrawnReason}</span>
                      ) : c.loan ? (
                        <>
                          With {c.loan.borrower}
                          <span className="block text-sm text-ink-3">
                            Due {formatCalendarDate(c.loan.dueOn)}
                          </span>
                        </>
                      ) : c.heldFor ? (
                        <StatusText tone="caution">Held for {c.heldFor}</StatusText>
                      ) : (
                        <StatusText tone="positive">In</StatusText>
                      )}
                    </TD>
                    {manage && (
                      <TD className="text-right">
                        {c.status === "active" && !c.loan && !c.heldFor && (
                          <ReasonDialog
                            action={withdrawCopyAction.bind(null, slug, t.id, c.id)}
                            trigger="Withdraw"
                            triggerLabel={`Withdraw ${c.number}`}
                            title={`Withdraw ${c.number}`}
                            description="Damaged or discarded. It stays on record and cannot be lent again."
                            label="Why"
                            required
                            submitLabel="Withdraw"
                          />
                        )}
                      </TD>
                    )}
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>

      {t.queue.length > 0 && (
        <Section
          title="Waiting for this book"
          description="The first in the queue gets the next copy returned."
        >
          <ol className="divide-y divide-line border-y border-line">
            {t.queue.map((r, i) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span className="text-base text-ink">
                  {i + 1}. {r.borrower}
                  <span className="block text-sm text-ink-3">
                    {RESERVATION_STATUS_LABELS[r.status]}
                    {r.copy ? `: ${r.copy}` : ""} · since {formatDateTime(r.reservedAt, tz)}
                  </span>
                </span>
                {manage && (
                  <ActionButton
                    action={cancelReservationAction.bind(null, slug, t.id, r.id)}
                    label="Cancel"
                    ariaLabel={`Cancel the reservation for ${r.borrower}`}
                  />
                )}
              </li>
            ))}
          </ol>
        </Section>
      )}
    </div>
  );
}
