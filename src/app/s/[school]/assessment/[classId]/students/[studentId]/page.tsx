import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileDown } from "lucide-react";
import { ReportCardView } from "@/components/assessment/report-card-view";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { getReportCard } from "@/server/assessment/report-cards";
import { db } from "@/server/db/client";
import { formatDateTime } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { publishAction, saveRemarksAction, withdrawAction } from "../../../actions";
import { PublishDialog, RemarksForm, WithdrawDialog } from "../../../assessment-controls";
import { chooseTerm, termQuery } from "../../../terms";

export const metadata: Metadata = { title: "Report card" };

export default async function ReportCardPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string; classId: string; studentId: string }>;
  searchParams: Promise<{ term?: string }>;
}) {
  const [{ school, classId, studentId }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const { term } = await chooseTerm(ctx, search.term);
  if (!term) notFound();
  const report = await getReportCard(db(), ctx, term.id, classId, studentId);
  if (!report) notFound();
  const { snapshot, cls } = report;
  const q = termQuery(term.id);
  const base = schoolPath(slug, `assessment/${cls.id}/students/${report.studentId}`);
  const published = report.status === "published";
  const ungraded = snapshot.subjects.length - snapshot.overall.graded;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link
            href={`${schoolPath(slug, `assessment/${cls.id}`)}${q}` as Route}
            className="-ml-2 inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            {cls.name}
          </Link>
          <h2 className="mt-1 flex flex-wrap items-center gap-2 font-display text-xl font-medium tracking-tight text-ink">
            {snapshot.student.name}
            {published ? <Badge tone="positive">Published</Badge> : <Badge>Draft</Badge>}
          </h2>
          <p className="mt-1 text-sm text-ink-3">
            {snapshot.student.admissionNumber} · {term.label}
            {published && report.publishedAt
              ? ` · Published ${formatDateTime(report.publishedAt, ctx.tenant.timezone)}`
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={`${base}/pdf${q}`} className={buttonStyles("secondary")}>
            <FileDown aria-hidden="true" />
            {published ? "Download PDF" : "Draft PDF"}
          </a>
          {published && report.canPublish && (
            <WithdrawDialog
              action={withdrawAction.bind(null, slug, term.id, cls.id, report.studentId)}
              name={snapshot.student.name}
            />
          )}
          {!published && report.canPublish && (
            <PublishDialog
              action={publishAction.bind(null, slug, term.id, cls.id, [report.studentId])}
              title={`Publish ${snapshot.student.name}'s report card`}
              trigger="Publish this report card"
              ready={ungraded === 0 ? 1 : 0}
              incomplete={ungraded === 0 ? 0 : 1}
            />
          )}
        </div>
      </div>

      <div className="grid gap-10 2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-labelledby="preview" className="space-y-3">
          <h3 id="preview" className="text-md font-semibold text-ink">
            {published ? "As published" : "Preview"}
          </h3>
          <ReportCardView card={snapshot} />
        </section>
        <section aria-labelledby="remarks" className="max-w-2xl space-y-3">
          <h3 id="remarks" className="text-md font-semibold text-ink">
            Remarks
          </h3>
          {published ? (
            <p className="text-base text-ink-2">
              Published report cards cannot be changed.
              {report.canPublish
                ? " Withdraw it to correct a mark or remark, then publish it again."
                : " Ask the head teacher to withdraw it if something needs correcting."}
            </p>
          ) : (
            <RemarksForm
              action={saveRemarksAction.bind(null, slug, term.id, cls.id, report.studentId)}
              values={report.remarks}
              canWriteHeadRemark={report.canPublish}
            />
          )}
        </section>
      </div>
    </div>
  );
}
