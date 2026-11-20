import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { School } from "lucide-react";
import { StatusText } from "@/components/ui/badge";
import { Button, buttonStyles } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { MoreMenu } from "@/components/ui/more-menu";
import {
  RowActions,
  Table,
  TableFrame,
  TBody,
  TD,
  TGroupLabel,
  TGroupRow,
  TH,
  THead,
  TR,
} from "@/components/ui/table";
import { getCurrentTerm } from "@/server/academics/calendar";
import {
  listLevelsWithClasses,
  listTeacherOptions,
  STAGES,
  type ClassSummary,
} from "@/server/academics/classes";
import { getTemplate } from "@/server/academics/templates";
import { CURRICULUM_TEMPLATES } from "@/lib/curricula";
import { allowed } from "@/server/authz/permissions";
import { listCampuses } from "@/server/campuses/service";
import { db } from "@/server/db/client";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import {
  addClassAction,
  addLevelAction,
  renameLevelAction,
  setClassStatusAction,
  setupLevelsAction,
  updateClassAction,
} from "./actions";
import {
  AddClassDialog,
  AddLevelDialog,
  ClassStatusDialog,
  EditClassDialog,
  RenameLevelDialog,
  SetupLevelsDialog,
} from "./class-controls";
import { ExpandingSearch } from "@/components/ui/expanding-search";

export const metadata: Metadata = { title: "Classes" };

type Show = "active" | "archived" | "all";

export default async function ClassesPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ q?: string; show?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "classes.view")) notFound();
  const canManage = allowed(ctx, "academics.manage");
  const [levels, campuses, teachers, template, currentTerm] = await Promise.all([
    listLevelsWithClasses(db(), ctx),
    listCampuses(db(), ctx),
    canManage ? listTeacherOptions(db(), ctx) : Promise.resolve([]),
    getTemplate(db(), ctx),
    getCurrentTerm(db(), ctx),
  ]);
  const slug = ctx.tenant.slug;
  const stageOptions = STAGES.map((s) => ({ value: s, label: template.stageLabels[s] }));
  const templateChoices = CURRICULUM_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    // A template without a senior secondary stage (most outside Ghana here) offers none.
    stages: STAGES.filter((s) => t.levels[s].length > 0).map((s) => ({
      value: s,
      label: t.stageLabels[s],
      levels: t.levels[s],
    })),
  }));
  const levelOptions = levels.map((l) => ({ value: l.id, label: l.name }));
  const campusOptions = campuses
    .filter((c) => c.status === "active")
    .map((c) => ({ value: c.id, label: c.name }));
  const teacherOptions = teachers.map((t) => ({ value: t.membershipId, label: t.name }));
  const multiCampus = campusOptions.length > 1;
  const addClass = (levelId?: string) => (
    <AddClassDialog
      action={addClassAction.bind(null, slug)}
      levels={levelOptions}
      campuses={campusOptions}
      teachers={teacherOptions}
      levelId={levelId}
    />
  );

  // Find and filter: archived classes are hidden unless asked for.
  const show: Show = search.show === "archived" || search.show === "all" ? search.show : "active";
  const q = (search.q ?? "").trim().toLowerCase();
  const filtered = Boolean(q) || show !== "active";
  const shownLevels = levels
    .map((level) => {
      const levelMatch = !q || level.name.toLowerCase().includes(q);
      const classes = level.classes.filter(
        (c) => (show === "all" || c.status === show) && (levelMatch || c.name.toLowerCase().includes(q)),
      );
      return { ...level, shown: classes, matches: levelMatch || classes.length > 0 };
    })
    // Searching hides levels with nothing to show; browsing keeps every level, empty ones included.
    .filter((level) => (q ? level.matches : show !== "archived" || level.shown.length > 0));
  // Levels arrive in promotion order; consecutive levels of one stage share a label.
  const stages: { stage: (typeof levels)[number]["stage"]; levels: typeof shownLevels }[] = [];
  for (const level of shownLevels) {
    const last = stages[stages.length - 1];
    if (last && last.stage === level.stage) last.levels.push(level);
    else stages.push({ stage: level.stage, levels: [level] });
  }
  const columns = 3 + (multiCampus ? 1 : 0) + (canManage ? 1 : 0);

  const status = (cls: ClassSummary) =>
    cls.status === "active" ? (
      <StatusText tone="positive">Active</StatusText>
    ) : (
      <StatusText tone="neutral">Archived</StatusText>
    );
  const teacher = (cls: ClassSummary) =>
    cls.classTeacher?.name ?? <span className="text-ink-3">Not assigned</span>;
  const classActions = (cls: ClassSummary) => (
    <>
      <EditClassDialog
        action={updateClassAction.bind(null, slug, cls.id)}
        name={cls.name}
        teacherId={cls.classTeacher?.membershipId}
        teachers={teacherOptions}
      />
      <ClassStatusDialog
        action={setClassStatusAction.bind(
          null,
          slug,
          cls.id,
          cls.status === "active" ? "archived" : "active",
        )}
        name={cls.name}
        archived={cls.status === "archived"}
      />
    </>
  );

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={currentTerm ? `${currentTerm.name}, ${currentTerm.yearName}` : undefined}
        title="Classes"
        description="Levels in promotion order, and the classes in each."
        actions={
          levels.length > 0 && (
            <>
              <ExpandingSearch
                form="class-filters"
                defaultValue={search.q}
                placeholder="Class or level"
                label="Find a class or level"
                buttonLabel="Find classes"
              />
              {canManage && (
                <>
                  <MoreMenu
                    items={[
                      ...(ctx.campusIds === null
                        ? [{ label: "Move to another term", href: schoolPath(slug, "classes/move") }]
                        : []),
                      { label: "Teaching", href: schoolPath(slug, "classes/teaching") },
                    ]}
                  />
                  <AddLevelDialog action={addLevelAction.bind(null, slug)} stages={stageOptions} />
                  {addClass()}
                </>
              )}
            </>
          )
        }
      />

      {levels.length === 0 ? (
        <EmptyState
          icon={<School />}
          title="No levels yet"
          description={
            canManage
              ? `Start from ${template.name}, or another starting point, then rename levels to match your school.`
              : "Your school has not set up its classes yet."
          }
          action={
            canManage && (
              <SetupLevelsDialog
                action={setupLevelsAction.bind(null, slug)}
                templates={templateChoices}
                defaultTemplate={template.id}
              />
            )
          }
        />
      ) : (
        <div className="space-y-4">
          <form
            id="class-filters"
            method="get"
            className="flex flex-col gap-2 sm:flex-row"
            role="search"
            aria-label="Find classes"
          >
            <label htmlFor="class-show" className="sr-only">
              Which classes
            </label>
            <Select id="class-show" name="show" defaultValue={show} className="sm:max-w-[10rem]">
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </Select>
            <Button type="submit" variant="secondary">
              Search
            </Button>
            {filtered && (
              <Link href={schoolPath(slug, "classes")} className={buttonStyles("ghost")}>
                Clear
              </Link>
            )}
          </form>

          {shownLevels.length === 0 ? (
            <EmptyState
              icon={<School />}
              title={show === "archived" && !q ? "No archived classes" : "No classes match"}
              description={
                show === "archived" && !q
                  ? "Archived classes appear here."
                  : "Try another class or level name."
              }
            />
          ) : (
            <TableFrame>
              <Table>
                <caption className="sr-only">Classes by level, in promotion order</caption>
                <THead>
                  <tr>
                    <TH>Class</TH>
                    {multiCampus && <TH className="hidden sm:table-cell">Campus</TH>}
                    <TH className="hidden sm:table-cell">Class teacher</TH>
                    <TH className="hidden sm:table-cell">Status</TH>
                    {canManage && (
                      <TH>
                        <span className="sr-only">Actions</span>
                      </TH>
                    )}
                  </tr>
                </THead>
                {stages.map((group) => (
                  <TBody key={`${group.stage}-${group.levels[0]!.id}`}>
                    <TGroupLabel colSpan={columns}>{template.stageLabels[group.stage]}</TGroupLabel>
                    {group.levels.map((level) => {
                      // One class: the level row carries it, without repeating the name.
                      const only = level.shown.length === 1 ? level.shown[0]! : null;
                      const empty = level.shown.length === 0;
                      // A level heads its rows only when it has several classes; otherwise it is the row.
                      const LevelRow = level.shown.length > 1 ? TGroupRow : TR;
                      const levelActions = canManage && (
                        <>
                          <RenameLevelDialog
                            action={renameLevelAction.bind(null, slug, level.id)}
                            name={level.name}
                          />
                          {/* An empty level offers Add class in its row; on phones it stays here. */}
                          {empty ? (
                            <span className="sm:hidden">{addClass(level.id)}</span>
                          ) : (
                            addClass(level.id)
                          )}
                        </>
                      );
                      return (
                        <Fragment key={level.id}>
                          <LevelRow>
                            <TD>
                              <span className="font-medium text-ink">{level.name}</span>
                              {only && only.name !== level.name && (
                                <span className="ml-2 text-sm text-ink-3">{only.name}</span>
                              )}
                              {level.shown.length > 1 && (
                                <span className="ml-2 text-sm text-ink-3 tabular-nums">
                                  {level.shown.length} classes
                                </span>
                              )}
                              {only && (
                                <span className="block text-sm text-ink-3 sm:hidden">
                                  {only.classTeacher?.name ?? "No class teacher"}
                                </span>
                              )}
                              {empty && (
                                <span className="block text-sm text-ink-3 sm:hidden">
                                  {level.classes.length === 0 ? "No classes yet" : `No ${show} classes`}
                                </span>
                              )}
                            </TD>
                            {empty ? (
                              <TD
                                colSpan={columns - 1 - (canManage ? 1 : 0)}
                                className="hidden sm:table-cell"
                              >
                                <span className="text-sm text-ink-3">
                                  {level.classes.length === 0 ? "No classes yet" : `No ${show} classes`}
                                </span>
                                {canManage && level.classes.length === 0 && (
                                  <span className="ml-2 inline-block">{addClass(level.id)}</span>
                                )}
                              </TD>
                            ) : (
                              <>
                                {multiCampus && <TD className="hidden sm:table-cell">{only?.campusName}</TD>}
                                <TD className="hidden sm:table-cell">{only && teacher(only)}</TD>
                                <TD className="hidden sm:table-cell">{only && status(only)}</TD>
                              </>
                            )}
                            {canManage && (
                              <TD className="text-right whitespace-nowrap">
                                <RowActions>
                                  {levelActions}
                                  {only && classActions(only)}
                                </RowActions>
                              </TD>
                            )}
                          </LevelRow>
                          {level.shown.length > 1 &&
                            level.shown.map((cls) => (
                              <TR key={cls.id}>
                                <TD className="pl-10!">
                                  <span className="text-ink">{cls.name}</span>
                                  {/* On small screens the class teacher sits under the class name. */}
                                  <span className="block text-sm text-ink-3 sm:hidden">
                                    {cls.classTeacher?.name ?? "No class teacher"}
                                  </span>
                                </TD>
                                {multiCampus && <TD className="hidden sm:table-cell">{cls.campusName}</TD>}
                                <TD className="hidden sm:table-cell">{teacher(cls)}</TD>
                                <TD className="hidden sm:table-cell">{status(cls)}</TD>
                                {canManage && (
                                  <TD className="text-right whitespace-nowrap">
                                    <RowActions>{classActions(cls)}</RowActions>
                                  </TD>
                                )}
                              </TR>
                            ))}
                        </Fragment>
                      );
                    })}
                  </TBody>
                ))}
              </Table>
            </TableFrame>
          )}
        </div>
      )}
    </div>
  );
}
