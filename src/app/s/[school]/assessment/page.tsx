import type { Metadata, Route } from "next";
import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { StatusText } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { listAssessmentClasses } from "@/server/assessment/scores";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { TermPicker } from "@/components/term-picker";
import { chooseTerm, termQuery } from "@/web/terms";

export const metadata: Metadata = { title: "Assessment" };

export default async function AssessmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ term?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const { terms, term } = await chooseTerm(ctx, search.term);
  if (!term) {
    return (
      <EmptyState
        icon={<ClipboardList />}
        title="No terms yet"
        description="Scores and report cards are kept per term. Add your academic year and its terms first."
        action={
          allowed(ctx, "academics.manage") && (
            <Link href={schoolPath(slug, "settings/calendar")} className={buttonStyles("primary")}>
              Set up the calendar
            </Link>
          )
        }
      />
    );
  }
  const data = await listAssessmentClasses(db(), ctx, term.id);
  const classes = data?.classes ?? [];

  return (
    <div className="space-y-6">
      <TermPicker terms={terms} termId={term.id} />
      {classes.length === 0 ? (
        <EmptyState
          icon={<ClipboardList />}
          title="No classes to assess"
          description={
            allowed(ctx, "academics.manage")
              ? "Add classes under Classes, then come back to enter scores."
              : "You enter scores for the classes you are class teacher of. Ask the head teacher to assign you a class."
          }
        />
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Classes, {term.label}</caption>
            <THead>
              <tr>
                <TH>Class</TH>
                <TH numeric className="hidden sm:table-cell">
                  Students
                </TH>
                <TH>Scores complete</TH>
                <TH>Report cards</TH>
              </tr>
            </THead>
            <TBody>
              {classes.map(({ cls, students, subjects, completeSheets, published }) => (
                <TR key={cls.id}>
                  <TD>
                    <Link
                      href={`${schoolPath(slug, `assessment/${cls.id}`)}${termQuery(term.id)}` as Route}
                      className="font-medium text-ink hover:text-accent hover:underline"
                    >
                      {cls.name}
                    </Link>
                    <span className="block text-sm text-ink-3">
                      {cls.classTeacherName ?? "No class teacher"}
                    </span>
                  </TD>
                  <TD numeric className="hidden sm:table-cell">
                    {students}
                  </TD>
                  <TD>
                    {subjects === 0 ? (
                      <span className="text-ink-3">No subjects</span>
                    ) : (
                      <StatusText
                        tone={
                          completeSheets === subjects ? "positive" : completeSheets ? "caution" : "neutral"
                        }
                      >
                        {completeSheets} of {subjects} subjects
                      </StatusText>
                    )}
                  </TD>
                  <TD>
                    {students === 0 ? (
                      <span className="text-ink-3">No students</span>
                    ) : (
                      <StatusText
                        tone={published === students ? "positive" : published ? "caution" : "neutral"}
                      >
                        {published === students ? "All published" : `${published} of ${students} published`}
                      </StatusText>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </div>
  );
}
