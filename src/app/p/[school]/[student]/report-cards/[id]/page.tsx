import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileDown } from "lucide-react";
import { ReportCardView } from "@/components/assessment/report-card-view";
import { db } from "@/server/db/client";
import { getParentReportCard } from "@/server/parents/portal";
import { requireParent } from "@/web/parent-auth";

export const metadata: Metadata = { title: "Report card" };

/** A published report card, readable on a phone, with the same PDF the school prints. */
export default async function ParentReportCardPage({
  params,
}: {
  params: Promise<{ school: string; student: string; id: string }>;
}) {
  const { school: slug, student: studentId, id } = await params;
  const { phone } = await requireParent();
  const card = await getParentReportCard(db(), phone, slug, studentId, id);
  if (!card) notFound();
  const base = `/p/${slug}/${studentId}`;
  return (
    <div className="space-y-6">
      <div>
        <Link
          href={base as Route}
          className="-ml-2 inline-flex h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {card.student.name}
        </Link>
        <h1 className="mt-2 font-display text-2xl font-medium tracking-tight">Report card</h1>
        <p className="mt-1 text-sm text-ink-3">
          {card.schoolName} · {card.term.name}, {card.term.yearName}
        </p>
      </div>
      <a
        href={`${base}/report-cards/${id}/pdf`}
        className="inline-flex h-11 items-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-base font-medium text-ink hover:bg-subtle"
      >
        <FileDown aria-hidden="true" className="size-4" />
        Download report card (PDF)
      </a>
      <ReportCardView card={card} />
    </div>
  );
}
