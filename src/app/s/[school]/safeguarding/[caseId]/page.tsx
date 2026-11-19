import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusText } from "@/components/ui/badge";
import { ActionButton, UploadForm } from "@/components/ui/action-forms";
import { DescriptionList, Section } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { getCase } from "@/server/safeguarding/service";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { CASE_STATUS_LABELS, CONCERN_CATEGORY_LABELS, ENTRY_KIND_LABELS } from "@/lib/safeguarding";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import {
  addEntryAction,
  assignLeadAction,
  markActionDoneAction,
  removeCaseDocumentAction,
  setStatusAction,
  uploadCaseDocumentAction,
} from "../actions";
import { AssignLeadForm, EntryDialog, StatusDialog } from "../safeguarding-controls";

export const metadata: Metadata = { title: "Safeguarding case" };

const TONE = { open: "critical", monitoring: "caution", closed: "neutral" } as const;

/** A case, for the school's safeguarding leads only (SFG-01b to SFG-01e). Opening it is recorded. */
export default async function CasePage({ params }: { params: Promise<{ school: string; caseId: string }> }) {
  const { school, caseId } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "safeguarding.manage")) notFound();
  let c;
  try {
    c = await getCase(db(), ctx, caseId);
  } catch (error) {
    if (error instanceof DomainError) notFound();
    throw error;
  }
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const base = schoolPath(slug, "safeguarding");

  return (
    <div className="space-y-10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link href={base} className="text-sm font-medium text-accent hover:underline">
            All cases
          </Link>
          <h1 className="mt-2 font-display text-2xl text-ink">
            {c.reference} · {c.student.name}
          </h1>
          <p className="text-base text-ink-3">
            {CONCERN_CATEGORY_LABELS[c.category]} ·{" "}
            <StatusText tone={TONE[c.status]}>{CASE_STATUS_LABELS[c.status]}</StatusText>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <EntryDialog action={addEntryAction.bind(null, slug, c.id)} />
          {c.status === "open" && (
            <StatusDialog action={setStatusAction.bind(null, slug, c.id, "monitoring")} status="monitoring" />
          )}
          {c.status !== "closed" ? (
            <StatusDialog action={setStatusAction.bind(null, slug, c.id, "closed")} status="closed" />
          ) : (
            <StatusDialog action={setStatusAction.bind(null, slug, c.id, "open")} status="open" />
          )}
        </div>
      </div>

      <Section
        title="The report"
        description="As written by the person who reported it. It is never changed."
      >
        <DescriptionList
          items={[
            { term: "Reported by", detail: `${c.reportedBy}, ${formatDateTime(c.reportedAt, tz)}` },
            { term: "Child", detail: `${c.student.name} (${c.student.admissionNumber})` },
            { term: "When", detail: c.occurredOn ? formatCalendarDate(c.occurredOn) : "Not given" },
            { term: "Where", detail: c.location ?? "Not given" },
            {
              term: "What was seen or said",
              detail: <span className="whitespace-pre-line">{c.description}</span>,
            },
            {
              term: "Done at once",
              detail: c.immediateAction ? (
                <span className="whitespace-pre-line">{c.immediateAction}</span>
              ) : (
                "Nothing recorded"
              ),
            },
          ]}
        />
      </Section>

      <Section title="Lead">
        <AssignLeadForm
          action={assignLeadAction.bind(null, slug, c.id)}
          leads={c.leads.map((l) => ({ membershipId: l.membershipId, name: l.name }))}
          current={c.lead?.membershipId ?? null}
        />
      </Section>

      <Section
        title="History"
        description="Notes, actions, referrals, contact with the family and meetings, newest first. Never edited or removed."
      >
        {c.entries.length === 0 ? (
          <p className="text-base text-ink-3">Nothing recorded yet.</p>
        ) : (
          <ol className="divide-y divide-line border-y border-line">
            {c.entries.map((e) => (
              <li
                key={e.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink-2">
                    {ENTRY_KIND_LABELS[e.kind]}
                    {e.kind === "action" && e.dueOn ? ` · due ${formatCalendarDate(e.dueOn)}` : ""}
                    {e.kind === "action" && e.doneAt
                      ? ` · done by ${e.doneBy ?? "a lead"}, ${formatDateTime(e.doneAt, tz)}`
                      : ""}
                  </p>
                  <p className="text-base whitespace-pre-line text-ink">{e.body}</p>
                  <p className="text-sm text-ink-3">
                    {e.by}, {formatDateTime(e.at, tz)}
                  </p>
                </div>
                {e.kind === "action" && !e.doneAt && (
                  <ActionButton
                    action={markActionDoneAction.bind(null, slug, c.id, e.id)}
                    label="Mark done"
                    ariaLabel={`Mark done: ${e.body.slice(0, 60)}`}
                  />
                )}
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section
        title="Documents"
        description="Confidential: only the school's safeguarding leads can open them. Every download is recorded."
      >
        {c.documents.length === 0 ? (
          <p className="text-base text-ink-3">No documents.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {c.documents.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <a
                    href={`${base}/${c.id}/documents/${d.id}`}
                    className="font-medium text-accent hover:underline"
                    aria-label={`Download ${d.filename}`}
                  >
                    {d.filename}
                  </a>
                  <p className="text-sm text-ink-3">
                    Added by {d.uploadedBy}, {formatDateTime(d.uploadedAt, tz)}
                  </p>
                </div>
                <ActionButton
                  action={removeCaseDocumentAction.bind(null, slug, c.id, d.id)}
                  label="Remove"
                  ariaLabel={`Remove ${d.filename}`}
                />
              </li>
            ))}
          </ul>
        )}
        <UploadForm
          action={uploadCaseDocumentAction.bind(null, slug, c.id)}
          label="Add a document"
          accept="application/pdf,image/png,image/jpeg"
          submitLabel="Upload"
        />
      </Section>

      <Section title="Who opened this case" description="Every opening and download by a lead, newest first.">
        <ul className="divide-y divide-line border-y border-line text-sm">
          {c.access.map((a, i) => (
            <li key={i} className="flex justify-between gap-3 py-2">
              <span className="text-ink">
                {a.user} {a.action === "viewed" ? "opened the case" : "downloaded a document"}
              </span>
              <span className="text-ink-3">{formatDateTime(a.at, tz)}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
