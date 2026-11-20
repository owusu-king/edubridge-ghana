import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { EmptyState } from "@/components/ui/layout";
import { getScoreSheet } from "@/server/assessment/scores";
import { getElectiveTakers } from "@/server/assessment/electives";
import { allowed } from "@/server/authz/permissions";
import { ElectiveTakersForm } from "../../../assessment-controls";
import { db } from "@/server/db/client";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { saveScoresAction, setTakersAction } from "../../../actions";
import { chooseTerm, termQuery } from "@/web/terms";
import { syncOperationsAction } from "../../../../sync-actions";
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
  const takers =
    sheet.subject.elective && allowed(ctx, "academics.manage")
      ? await getElectiveTakers(db(), ctx, term.id, classId, subjectId)
      : null;
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
        <Link
          href={
            `${schoolPath(slug, `assessment/${sheet.cls.id}/subjects/${sheet.subject.id}/comments`)}${termQuery(term.id)}` as Route
          }
          className="mt-2 inline-flex text-sm font-medium text-accent hover:underline"
        >
          Comments for report cards
        </Link>
      </div>
      {takers && (
        <ElectiveTakersForm
          action={setTakersAction.bind(null, slug, term.id, sheet.cls.id, sheet.subject.id)}
          subjectName={sheet.subject.name}
          students={takers.students}
        />
      )}
      {sheet.students.length === 0 ? (
        <EmptyState
          title={sheet.subject.elective ? "Nobody takes this elective yet" : "No students in this class"}
          description={
            sheet.subject.elective
              ? "Choose the students who take it; their marks are entered here."
              : "Students placed in this class for the term appear here."
          }
        />
      ) : (
        <ScoreSheet
          action={saveScoresAction.bind(null, slug, term.id, sheet.cls.id, sheet.subject.id)}
          version={JSON.stringify(sheet.students.map((s) => [s.scores, s.locked]))}
          components={sheet.components}
          bands={sheet.bands}
          students={sheet.students}
          subjectName={sheet.subject.name}
          sync={{
            school: slug,
            userId: ctx.userId,
            termId: term.id,
            classId: sheet.cls.id,
            subjectId: sheet.subject.id,
            label: `${sheet.subject.name}, ${sheet.cls.name}`,
            action: syncOperationsAction,
          }}
        />
      )}
    </div>
  );
}
