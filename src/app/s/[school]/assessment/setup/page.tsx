import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BookOpen } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { buttonStyles } from "@/components/ui/button";
import { FormDialog } from "@/components/ui/form-dialog";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { STAGE_LABELS } from "@/server/academics/classes";
import { getAssessmentSetup } from "@/server/assessment/setup";
import { can } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import {
  addSubjectAction,
  resetScaleAction,
  saveScaleAction,
  saveSchemeAction,
  setupSubjectsAction,
  updateSubjectAction,
} from "../actions";
import { ScaleForm, SchemeForm, SubjectDialog } from "../assessment-controls";
import { TermPicker } from "../term-picker";
import { chooseTerm } from "../terms";

export const metadata: Metadata = { title: "Assessment setup" };

export default async function AssessmentSetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ term?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "academics.manage")) notFound();
  const slug = ctx.tenant.slug;
  const { terms, term } = await chooseTerm(ctx, search.term);
  if (!term) {
    return (
      <EmptyState
        icon={<BookOpen />}
        title="No terms yet"
        description="How each term is assessed is set per term. Add your academic year and its terms first."
        action={
          <Link href={schoolPath(slug, "settings/calendar")} className={buttonStyles("primary")}>
            Set up the calendar
          </Link>
        }
      />
    );
  }
  const setup = await getAssessmentSetup(db(), ctx, term.id);
  if (!setup) notFound();
  const levelOptions = setup.levels.map((l) => ({ id: l.id, name: l.name }));
  const levelName = new Map(setup.levels.map((l) => [l.id, l.name]));
  const { scheme } = setup;

  return (
    <div className="space-y-12">
      <Section
        title="Subjects"
        description="What each level takes, in report-card order."
        aside={
          setup.subjects.length > 0 && (
            <SubjectDialog action={addSubjectAction.bind(null, slug)} levels={levelOptions} />
          )
        }
      >
        {setup.levels.length === 0 ? (
          <EmptyState
            icon={<BookOpen />}
            title="No levels yet"
            description="Subjects are chosen per level. Set up your levels under Classes first."
            action={
              <Link href={schoolPath(slug, "classes")} className={buttonStyles("primary")}>
                Go to classes
              </Link>
            }
          />
        ) : setup.subjects.length === 0 ? (
          <EmptyState
            icon={<BookOpen />}
            title="No subjects yet"
            description="Start with the GES Standards-Based Curriculum subjects for each of your levels. You can rename, add and remove them."
            action={
              <FormDialog
                trigger="Add the GES subjects"
                triggerVariant="primary"
                title="Add the GES subjects"
                description="KG levels get the four KG learning areas; primary and JHS levels get their curriculum subjects. Lower primary often does not take French or History; remove them per level afterwards."
                submitLabel="Add subjects"
                action={setupSubjectsAction.bind(null, slug)}
              />
            }
          />
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Subjects</caption>
              <THead>
                <tr>
                  <TH>Subject</TH>
                  <TH>Levels</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {setup.subjects.map((subject) => (
                  <TR key={subject.id}>
                    <TD className="font-medium text-ink">{subject.name}</TD>
                    <TD className="text-sm">
                      {subject.levelIds.length === 0 ? (
                        <span className="text-ink-3">No levels</span>
                      ) : subject.levelIds.length === setup.levels.length ? (
                        "Every level"
                      ) : (
                        subject.levelIds
                          .map((id) => levelName.get(id))
                          .filter(Boolean)
                          .join(", ")
                      )}
                    </TD>
                    <TD className="text-right">
                      <SubjectDialog
                        action={updateSubjectAction.bind(null, slug, subject.id)}
                        levels={levelOptions}
                        subject={subject}
                      />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>

      <Section
        title="How the term is assessed"
        description="The parts of each subject's mark and their weights. Teachers enter each part out of its own maximum."
      >
        <TermPicker terms={terms} termId={term.id} />
        {scheme.publishedCount > 0 ? (
          <Alert>
            {scheme.publishedCount} report {scheme.publishedCount === 1 ? "card is" : "cards are"} published
            for {term.label}, so its assessment is fixed. Withdraw{" "}
            {scheme.publishedCount === 1 ? "it" : "them"} to make changes.
          </Alert>
        ) : !scheme.saved ? (
          <p className="text-sm text-ink-3">
            {term.label} follows the previous term&apos;s assessment, or the default, until it is saved or the
            first mark is entered.
          </p>
        ) : null}
        <div className="max-w-2xl rounded-lg border border-line bg-surface p-5 shadow-raised">
          <SchemeForm
            key={term.id}
            action={saveSchemeAction.bind(null, slug, term.id)}
            components={scheme.components}
            showPositions={scheme.showPositions}
            locked={scheme.publishedCount > 0}
          />
        </div>
      </Section>

      <Section
        title="Grades"
        description="The lowest whole mark for each grade, per stage. Published report cards keep the grades they were published with."
      >
        {setup.scales.length === 0 ? (
          <p className="text-base text-ink-3">Grades appear here once your levels are set up.</p>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            {setup.scales.map((scale) => (
              <div key={scale.stage} className="rounded-lg border border-line bg-surface p-5 shadow-raised">
                <h3 className="mb-3 text-base font-semibold text-ink">
                  {STAGE_LABELS[scale.stage]}
                  <span className="ml-2 text-sm font-normal text-ink-3">
                    {scale.custom ? "Your school's" : "Default"}
                  </span>
                </h3>
                <ScaleForm
                  action={saveScaleAction.bind(null, slug, scale.stage)}
                  resetAction={resetScaleAction.bind(null, slug, scale.stage)}
                  stageLabel={STAGE_LABELS[scale.stage]}
                  bands={scale.bands}
                  custom={scale.custom}
                />
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
