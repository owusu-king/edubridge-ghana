import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarRange } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { StatusText } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { EmptyState, PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getMovePreview, type MoveTerm } from "@/server/academics/term-move";
import { allowed } from "@/server/authz/permissions";
import { listCampuses } from "@/server/campuses/service";
import { db } from "@/server/db/client";
import { formatDateTime } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { destinationValue } from "@/lib/term-move";
import { requireTenant } from "@/web/auth";
import { makeTermCurrentAction, moveStudentsAction, undoMoveAction } from "../actions";
import { MoveForm, type DestinationOption } from "./move-form";

export const metadata: Metadata = { title: "Move students to another term" };

const label = (t: MoveTerm) => `${t.name}, ${t.yearName}`;

export default async function MoveStudentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "academics.manage")) notFound();
  const slug = ctx.tenant.slug;
  const header = (
    <div className="space-y-4">
      <Link
        href={schoolPath(slug, "classes")}
        className="inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Classes
      </Link>
      <PageHeader
        title="Move students to another term"
        description="At the start of a term, put every student into their class for it in one step: the same classes within a year, or up a level into a new year. You see where everyone goes before anything changes, and can undo it until fees, registers or marks are recorded for the new term."
      />
    </div>
  );
  if (ctx.campusIds !== null)
    return (
      <div className="space-y-8">
        {header}
        <Alert tone="info">
          Moving students affects the whole school, and your access is limited to some campuses. Ask a
          colleague with access to every campus.
        </Alert>
      </div>
    );

  const [preview, campuses] = await Promise.all([
    getMovePreview(db(), ctx, { from: search.from, to: search.to }),
    listCampuses(db(), ctx),
  ]);
  const { from, to } = preview;
  const multiCampus = campuses.filter((c) => c.status === "active").length > 1;
  const campusName = (id: string) => campuses.find((c) => c.id === id)?.name ?? null;
  const options: DestinationOption[] = [
    ...preview.destinations.map((c) => ({
      value: c.id,
      label: multiCampus ? `${c.name} (${campusName(c.campusId)})` : c.name,
    })),
    ...(preview.newYear ? [{ value: "graduate", label: "Graduate (leaving the school)" }] : []),
    { value: "none", label: "Don't move" },
  ];

  return (
    <div className="space-y-10">
      {header}

      {preview.terms.length > 1 && from && (
        <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Choose terms">
          <div className="space-y-1.5">
            <label htmlFor="move-from" className="block text-sm font-medium text-ink">
              From
            </label>
            <Select id="move-from" name="from" defaultValue={from.id} className="min-w-52">
              {preview.terms.map((t) => (
                <option key={t.id} value={t.id}>
                  {label(t)}
                  {t.isCurrent ? " (current)" : ""}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="move-to" className="block text-sm font-medium text-ink">
              To
            </label>
            <Select id="move-to" name="to" defaultValue={to?.id} className="min-w-52">
              {preview.terms
                .filter((t) => t.startsOn > from.startsOn)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {label(t)}
                    {t.isCurrent ? " (current)" : ""}
                  </option>
                ))}
            </Select>
          </div>
          <button type="submit" className={buttonStyles("secondary")}>
            Show
          </button>
        </form>
      )}

      {!from || !to ? (
        <EmptyState
          icon={<CalendarRange />}
          title="No later term to move into"
          description="Add the next academic year and its terms first. Then come back to move students into them."
          action={
            <Link href={schoolPath(slug, "settings/calendar")} className={buttonStyles("primary")}>
              Open the calendar
            </Link>
          }
        />
      ) : preview.classes.length === 0 ? (
        <EmptyState
          icon={<CalendarRange />}
          title={`Nobody is in a class for ${label(from)}`}
          description="Choose a term whose classes have students in them."
        />
      ) : (
        <Section
          title={`${label(from)} to ${label(to)}`}
          description={
            preview.newYear
              ? "A new academic year: each class goes up to the next level's matching class, and the last level graduates. Change any destination below."
              : "The same academic year: each class carries over as it is. Change any destination below."
          }
          aside={
            !to.isCurrent && (
              <FormDialog
                trigger={`Make ${to.name} current`}
                title={`Make ${label(to)} the current term?`}
                description="Fees, registers and the overview default to the current term."
                submitLabel="Make current"
                action={makeTermCurrentAction.bind(null, slug, to.id)}
              />
            )
          }
        >
          {preview.alreadyPlaced > 0 && (
            <Alert tone="info">
              {preview.alreadyPlaced} {preview.alreadyPlaced === 1 ? "student is" : "students are"} already in
              a class for {label(to)} and will be left as they are.
            </Alert>
          )}
          <MoveForm
            key={`${from.id}:${to.id}`}
            fromTermId={from.id}
            toTermId={to.id}
            toLabel={label(to)}
            newYear={preview.newYear}
            options={options}
            action={moveStudentsAction.bind(null, slug)}
            classes={preview.classes.map((c) => ({
              id: c.cls.id,
              name: c.cls.name,
              campusName: multiCampus ? campusName(c.cls.campusId) : null,
              destination: destinationValue(c.destination),
              students: c.students,
            }))}
          />
        </Section>
      )}

      {preview.moves.length > 0 && (
        <Section
          title="Recent moves"
          description="A move can be undone until anything is recorded for its students in the new term."
        >
          <TableFrame>
            <Table>
              <caption className="sr-only">Recent moves</caption>
              <THead>
                <tr>
                  <TH>Move</TH>
                  <TH className="text-right">Placed</TH>
                  <TH className="hidden text-right sm:table-cell">Graduated</TH>
                  <TH className="hidden md:table-cell">By</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {preview.moves.map((m) => (
                  <TR key={m.id}>
                    <TD>
                      <span className="text-ink">
                        {m.from} to {m.to}
                      </span>
                      <span className="block text-sm text-ink-3">
                        {formatDateTime(m.createdAt, ctx.tenant.timezone)}
                      </span>
                    </TD>
                    <TD className="text-right tabular-nums">{m.placed}</TD>
                    <TD className="hidden text-right tabular-nums sm:table-cell">{m.graduated}</TD>
                    <TD className="hidden md:table-cell">{m.by}</TD>
                    <TD className="text-right">
                      {m.undoneAt ? (
                        <StatusText tone="neutral">Undone</StatusText>
                      ) : (
                        <FormDialog
                          trigger="Undo"
                          triggerSize="sm"
                          triggerVariant="ghost"
                          triggerLabel={`Undo the move from ${m.from} to ${m.to}`}
                          title="Undo this move?"
                          description={`Removes the ${m.placed} class placements it made in ${m.to}${m.graduated ? ` and makes the ${m.graduated} students it graduated active again` : ""}.`}
                          submitLabel="Undo move"
                          danger
                          action={undoMoveAction.bind(null, slug, m.id)}
                        />
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        </Section>
      )}
    </div>
  );
}
