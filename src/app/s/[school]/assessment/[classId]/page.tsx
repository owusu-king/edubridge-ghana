import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge, StatusText } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { getClassOverview } from "@/server/assessment/report-cards";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { ordinal } from "@/lib/assessment";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { printAction, publishAction } from "../actions";
import { PrintDialog, PublishDialog } from "../assessment-controls";
import { chooseTerm, termQuery } from "@/web/terms";

export const metadata: Metadata = { title: "Class assessment" };

const STATUS = {
  none: { label: "Draft", tone: "neutral" },
  draft: { label: "Draft", tone: "neutral" },
  published: { label: "Published", tone: "positive" },
} as const;

export default async function ClassAssessmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string; classId: string }>;
  searchParams: Promise<{ term?: string }>;
}) {
  const [{ school, classId }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const { term } = await chooseTerm(ctx, search.term);
  if (!term) notFound();
  const overview = await getClassOverview(db(), ctx, term.id, classId);
  if (!overview) notFound();
  const { cls, subjects, students, showPositions } = overview;
  const q = termQuery(term.id);
  const base = schoolPath(slug, `assessment/${cls.id}`);
  const drafts = students.filter((s) => s.status !== "published");
  const incomplete = drafts.filter((s) => s.result.graded < subjects.length).length;
  const published = students.length - drafts.length;
  const canPublish = allowed(ctx, "reports.publish");

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link
            href={`${schoolPath(slug, "assessment")}${q}` as Route}
            className="-ml-2 inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            All classes
          </Link>
          <h2 className="mt-1 font-display text-xl font-medium tracking-tight text-ink">{cls.name}</h2>
          <p className="mt-1 text-sm text-ink-3">
            {term.label} · {overview.componentsLabel}
            {cls.classTeacherName ? ` · Class teacher ${cls.classTeacherName}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {published > 0 && (
            <PrintDialog
              action={printAction.bind(null, slug, term.id, [cls.id])}
              label={`${cls.name} report cards`}
              count={published}
            />
          )}
          {canPublish && drafts.length > 0 && subjects.length > 0 && (
            <PublishDialog
              action={publishAction.bind(null, slug, term.id, cls.id, null)}
              title={`Publish ${cls.name} report cards`}
              ready={drafts.length - incomplete}
              incomplete={incomplete}
            />
          )}
        </div>
      </div>

      <section aria-labelledby="subjects" className="space-y-3">
        <h3 id="subjects" className="text-md font-semibold text-ink">
          Score sheets
        </h3>
        {subjects.length === 0 ? (
          <EmptyState
            title="No subjects for this level"
            description={
              allowed(ctx, "academics.manage")
                ? `Choose the subjects ${cls.levelName} takes under Assessment, Setup.`
                : `The head teacher has not chosen the subjects ${cls.levelName} takes yet.`
            }
          />
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Score sheets for {cls.name}</caption>
              <THead>
                <tr>
                  <TH>Subject</TH>
                  <TH>Complete</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {subjects.map((subject) => (
                  <TR key={subject.id}>
                    <TD className="font-medium text-ink">{subject.name}</TD>
                    <TD>
                      {students.length === 0 ? (
                        <span className="text-ink-3">No students</span>
                      ) : (
                        <StatusText
                          tone={
                            subject.complete === students.length
                              ? "positive"
                              : subject.entered
                                ? "caution"
                                : "neutral"
                          }
                        >
                          {subject.complete} of {students.length} students
                        </StatusText>
                      )}
                    </TD>
                    <TD className="text-right">
                      <Link
                        href={`${base}/subjects/${subject.id}${q}` as Route}
                        className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-medium whitespace-nowrap text-accent hover:bg-accent-soft"
                        aria-label={`Enter ${subject.name} scores`}
                      >
                        Enter scores
                      </Link>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </section>

      <section aria-labelledby="reports" className="space-y-3">
        <div>
          <h3 id="reports" className="text-md font-semibold text-ink">
            Report cards
          </h3>
          <p className="mt-0.5 text-sm text-ink-3">
            {published} of {students.length} published. Open a student to write remarks and check the report
            card.
          </p>
        </div>
        {students.length === 0 ? (
          <EmptyState
            title="No students in this class"
            description="Students placed in this class for the term appear here."
          />
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Report cards for {cls.name}</caption>
              <THead>
                <tr>
                  <TH>Student</TH>
                  <TH numeric>Average</TH>
                  {showPositions && (
                    <TH numeric className="hidden sm:table-cell">
                      Position
                    </TH>
                  )}
                  <TH className="hidden md:table-cell">Graded</TH>
                  <TH className="hidden md:table-cell">Remarks</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <TBody>
                {students.map((s) => (
                  <TR key={s.id}>
                    <TD>
                      <Link
                        href={`${base}/students/${s.id}${q}` as Route}
                        className="font-medium text-ink hover:text-accent hover:underline"
                      >
                        {s.name}
                      </Link>
                      <span className="block text-sm text-ink-3">{s.admissionNumber}</span>
                    </TD>
                    <TD numeric>
                      {s.result.average !== null ? (
                        s.result.average.toFixed(1)
                      ) : (
                        <span className="text-ink-3">—</span>
                      )}
                    </TD>
                    {showPositions && (
                      <TD numeric className="hidden sm:table-cell">
                        {s.result.position !== null ? (
                          ordinal(s.result.position)
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </TD>
                    )}
                    <TD className="hidden md:table-cell">
                      <span className={s.result.graded < subjects.length ? "text-caution" : undefined}>
                        {s.result.graded} of {subjects.length}
                      </span>
                    </TD>
                    <TD className="hidden md:table-cell">
                      {[s.hasClassTeacherRemark && "Class teacher", s.hasHeadTeacherRemark && "Head teacher"]
                        .filter(Boolean)
                        .join(", ") || <span className="text-ink-3">None yet</span>}
                    </TD>
                    <TD>
                      {s.status === "published" ? (
                        <Badge tone="positive">Published</Badge>
                      ) : (
                        <StatusText tone={STATUS[s.status].tone}>{STATUS[s.status].label}</StatusText>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </section>
    </div>
  );
}
