import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge, StatusText } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { DescriptionList, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { db } from "@/server/db/client";
import { getConsentForm } from "@/server/events/consent";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import {
  cancelConsentAction,
  changeDeadlineAction,
  paperAnswerAction,
  remindConsentAction,
} from "../../actions";
import { CancelFormDialog, DeadlineDialog, PaperAnswerDialog, RemindDialog } from "../../event-controls";

export const metadata: Metadata = { title: "Consent form" };

/** One consent form: its wording, and each child's answer (teachers: their classes only). */
export default async function ConsentFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string; id: string }>;
  searchParams: Promise<{ class?: string }>;
}) {
  const [{ school, id }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const form = await getConsentForm(db(), ctx, id, { classId: search.class });
  if (!form) notFound();
  const tz = ctx.tenant.timezone;
  const classId = form.classes.some((c) => c.id === search.class) ? search.class : undefined;

  return (
    <div className="space-y-10">
      <div className="space-y-3">
        <Link
          href={schoolPath(slug, "events/forms") as Route}
          className="-ml-2 inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Consent forms
        </Link>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-xl font-medium tracking-tight text-ink">{form.title}</h2>
              {form.cancelled ? (
                <Badge tone="critical">Cancelled</Badge>
              ) : form.open ? (
                <Badge tone="accent">Taking answers</Badge>
              ) : (
                <Badge>Closed</Badge>
              )}
            </div>
            <p className="text-sm text-ink-3">
              {form.audienceLabel} · sent by {form.by} on {formatDateTime(form.createdAt, tz)}
            </p>
          </div>
          {form.canManage && (
            <div className="flex shrink-0 flex-wrap gap-2">
              {form.open && form.counts.waiting > 0 && form.canRemind && (
                <RemindDialog
                  action={remindConsentAction.bind(null, slug, form.id)}
                  waiting={form.counts.waiting}
                  smsPaused={ctx.billing.state === "limited"}
                />
              )}
              <DeadlineDialog
                action={changeDeadlineAction.bind(null, slug, form.id)}
                deadline={form.deadline}
              />
              <CancelFormDialog action={cancelConsentAction.bind(null, slug, form.id)} title={form.title} />
            </div>
          )}
        </div>
      </div>

      <DescriptionList
        items={[
          { term: "Answers until", detail: `End of ${formatCalendarDate(form.deadline)}` },
          ...(form.event ? [{ term: "Event", detail: `${form.event.title}, ${form.event.when}` }] : []),
          {
            term: "Answers",
            detail: `${form.counts.yes} yes, ${form.counts.no} no, ${form.counts.waiting} waiting, of ${form.counts.children} ${form.counts.children === 1 ? "child" : "children"}`,
          },
          {
            term: "Families told",
            detail:
              `${form.pushCount} by notification, ${form.smsCount} by SMS` +
              (form.lastRemindedAt ? `; last on ${formatDateTime(form.lastRemindedAt, tz)}` : ""),
          },
        ]}
      />

      <Section title="What families are agreeing to">
        <p className="max-w-2xl rounded-lg border border-line bg-surface px-5 py-4 text-base whitespace-pre-line text-ink-2">
          {form.body}
        </p>
      </Section>

      <Section
        title="Answers"
        description="The latest answer for each child counts. Every answer is kept, with who gave it and how."
      >
        {form.classes.length > 1 && (
          <form method="get" className="flex items-end gap-2" aria-label="Choose a class">
            <div className="space-y-1.5">
              <label htmlFor="consent-class" className="block text-sm font-medium text-ink">
                Class
              </label>
              <Select id="consent-class" name="class" defaultValue={classId ?? ""} className="min-w-48">
                <option value="">Every class</option>
                {form.classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <button type="submit" className={buttonStyles("secondary")}>
              Show
            </button>
          </form>
        )}
        {form.children.length === 0 ? (
          <p className="text-base text-ink-3">No children here are on this form.</p>
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Answers for {form.title}</caption>
              <THead>
                <tr>
                  <TH>Child</TH>
                  <TH className="hidden sm:table-cell">Class</TH>
                  <TH>Answer</TH>
                  <TH className="hidden md:table-cell">Given by</TH>
                  {form.canManage && <TH className="sr-only">Actions</TH>}
                </tr>
              </THead>
              <TBody>
                {form.children.map((c) => (
                  <TR key={c.studentId}>
                    <TD>
                      <span className="font-medium text-ink">{c.name}</span>
                      <span className="block text-sm text-ink-3">{c.admissionNumber}</span>
                    </TD>
                    <TD className="hidden sm:table-cell">{c.className ?? "No class"}</TD>
                    <TD>
                      {c.answer === "yes" ? (
                        <StatusText tone="positive">Yes</StatusText>
                      ) : c.answer === "no" ? (
                        <StatusText tone="critical">No</StatusText>
                      ) : (
                        <StatusText tone="neutral">Waiting</StatusText>
                      )}
                      {c.note && <span className="block text-sm text-ink-2">“{c.note}”</span>}
                      {c.changed && <span className="block text-sm text-ink-3">Answer changed</span>}
                    </TD>
                    <TD className="hidden text-sm text-ink-2 md:table-cell">
                      {c.answeredBy}
                      {c.answeredAt && (
                        <span className="block text-ink-3">{formatDateTime(c.answeredAt, tz)}</span>
                      )}
                    </TD>
                    {form.canManage && (
                      <TD className="text-right">
                        {c.guardians.length > 0 && (
                          <PaperAnswerDialog
                            action={paperAnswerAction.bind(null, slug, form.id, c.studentId)}
                            child={c.name}
                            guardians={c.guardians}
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
    </div>
  );
}
