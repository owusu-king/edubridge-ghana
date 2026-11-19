import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui/layout";
import { LessonText, TimetableGrid } from "@/components/timetable/timetable-grid";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getClassTimetable } from "@/server/timetable/service";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { chooseTerm, termQuery } from "@/web/terms";
import { setLessonAction } from "../actions";
import { ClassTimetableEditor } from "../timetable-controls";

export const metadata: Metadata = { title: "Class timetable" };

/** One class's lessons for a term; academic staff plan them here. */
export default async function ClassTimetablePage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string; classId: string }>;
  searchParams: Promise<{ term?: string }>;
}) {
  const [{ school, classId }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "timetable.view")) notFound();
  const slug = ctx.tenant.slug;
  const { term } = await chooseTerm(ctx, search.term);
  if (!term) notFound();
  const timetable = await getClassTimetable(db(), ctx, term.id, classId);
  if (!timetable) notFound();
  const lessonPeriods = timetable.periods.filter((p) => p.kind === "lesson").length;

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`${schoolPath(slug, "timetable")}${termQuery(term.id)}` as Route}
          className="-ml-2 inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm text-ink-2 hover:text-ink"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Timetable
        </Link>
        <PageHeader
          eyebrow={`${timetable.cls.levelName} · ${timetable.cls.campusName}`}
          title={`${timetable.cls.name} timetable`}
          description={`${term.label}. ${timetable.lessons.length} of ${lessonPeriods * 5} lesson periods planned.${timetable.canManage ? " Choose a slot to set its subject and teacher." : ""}`}
        />
      </div>
      {timetable.periods.length === 0 ? (
        <p className="text-base text-ink-3">
          The school day has no periods yet.{" "}
          {timetable.canManage && (
            <Link href={schoolPath(slug, "timetable") as Route} className="text-accent hover:underline">
              Add them first
            </Link>
          )}
        </p>
      ) : timetable.canManage && timetable.options ? (
        <ClassTimetableEditor
          action={setLessonAction.bind(null, slug)}
          termId={term.id}
          classId={timetable.cls.id}
          className={timetable.cls.name}
          periods={timetable.periods}
          lessons={timetable.lessons.map((l) => ({
            weekday: l.weekday,
            periodId: l.periodId,
            subjectId: l.subjectId,
            subjectName: l.subjectName,
            membershipId: l.membershipId,
            teacherName: l.teacherName,
          }))}
          subjects={timetable.options.subjects}
          teachers={timetable.options.teachers}
        />
      ) : (
        <TimetableGrid
          periods={timetable.periods}
          caption={`${timetable.cls.name} timetable, ${term.label}`}
          cell={(weekday, period) => {
            const lesson = timetable.lessons.find((l) => l.weekday === weekday && l.periodId === period.id);
            return lesson ? <LessonText title={lesson.subjectName} detail={lesson.teacherName} /> : null;
          }}
        />
      )}
    </div>
  );
}
