import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { EmptyState } from "@/components/ui/layout";
import { COMMENT_MAX, getSubjectComments } from "@/server/assessment/comments";
import { db } from "@/server/db/client";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { chooseTerm, termQuery } from "@/web/terms";
import { saveCommentsAction } from "../../../../actions";
import { CommentsForm } from "./comments-form";

export const metadata: Metadata = { title: "Subject comments" };

/** The subject teacher's comment on each student, printed on report cards. */
export default async function SubjectCommentsPage({
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
  const view = await getSubjectComments(db(), ctx, term.id, classId, subjectId);
  if (!view) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={
            `${schoolPath(slug, `assessment/${view.cls.id}/subjects/${view.subject.id}`)}${termQuery(term.id)}` as Route
          }
          className="-ml-2 inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {view.subject.name} marks
        </Link>
        <h2 className="mt-1 font-display text-xl font-medium tracking-tight text-ink">
          {view.subject.name} comments · {view.cls.name}
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-3">
          {term.label}. Each comment is printed under the subject on the student&apos;s report card, with your
          name. Comments lock when the report card is published.
        </p>
      </div>
      {view.students.length === 0 ? (
        <EmptyState
          title="No students in this class"
          description="Students placed in this class for the term appear here."
        />
      ) : (
        <CommentsForm
          action={saveCommentsAction.bind(null, slug, term.id, view.cls.id, view.subject.id)}
          version={JSON.stringify(view.students.map((s) => [s.comment, s.locked]))}
          students={view.students}
          max={COMMENT_MAX}
        />
      )}
    </div>
  );
}
