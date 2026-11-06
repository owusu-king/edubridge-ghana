import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { EmptyState } from "@/components/ui/layout";
import { getScoreSheet } from "@/server/assessment/scores";
import { db } from "@/server/db/client";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { saveScoresAction } from "../../../actions";
import { chooseTerm, termQuery } from "../../../terms";
import { ScoreSheet } from "./score-sheet";

export const metadata: Metadata = { title: "Score sheet" };

export default async function ScoreSheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string; classId: string; subjectId: string }>;
  searchParams: Promise<{ term?: string }>;
}) {
  const [{ school, classId, subjectId }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const { term } = await chooseTerm(ctx, search.term);
  if (!term) notFound();
  const sheet = await getScoreSheet(db(), ctx, term.id, classId, subjectId);
  if (!sheet) notFound();
  const lockedCount = sheet.students.filter((s) => s.locked).length;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`${schoolPath(slug, `assessment/${sheet.cls.id}`)}${termQuery(term.id)}` as Route}
          className="-ml-2 inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {sheet.cls.name}
        </Link>
        <h2 className="mt-1 font-display text-xl font-medium tracking-tight text-ink">
          {sheet.subject.name} · {sheet.cls.name}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-3">
          {term.label}. Totals are out of 100 and rounded to a whole mark; a subject is graded once every part
          has a mark. Leave a mark empty if it is not in yet.
          {lockedCount > 0 &&
            ` ${lockedCount} ${lockedCount === 1 ? "student's report card is" : "students' report cards are"} published, so their marks are locked.`}
        </p>
      </div>
      {sheet.students.length === 0 ? (
        <EmptyState
          title="No students in this class"
          description="Students placed in this class for the term appear here."
        />
      ) : (
        <ScoreSheet
          action={saveScoresAction.bind(null, slug, term.id, sheet.cls.id, sheet.subject.id)}
          version={JSON.stringify(sheet.students.map((s) => [s.scores, s.locked]))}
          components={sheet.components}
          bands={sheet.bands}
          students={sheet.students}
          subjectName={sheet.subject.name}
        />
      )}
    </div>
  );
}
