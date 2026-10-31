import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { School } from "lucide-react";
import { StatusText } from "@/components/ui/badge";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { listLevelsWithClasses, listTeacherOptions, STAGE_LABELS, STAGES } from "@/server/academics/classes";
import { can } from "@/server/authz/permissions";
import { listCampuses } from "@/server/campuses/service";
import { db } from "@/server/db/client";
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

export const metadata: Metadata = { title: "Classes" };

export default async function ClassesPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "classes.view")) notFound();
  const canManage = can(ctx.roles, "academics.manage");
  const [levels, campuses, teachers] = await Promise.all([
    listLevelsWithClasses(db(), ctx),
    listCampuses(db(), ctx),
    canManage ? listTeacherOptions(db(), ctx) : Promise.resolve([]),
  ]);
  const slug = ctx.tenant.slug;
  const stageOptions = STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] }));
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

  return (
    <div className="space-y-8">
      <PageHeader
        title="Classes"
        description="Levels in promotion order, and the classes in each."
        actions={
          canManage &&
          levels.length > 0 && (
            <>
              <AddLevelDialog action={addLevelAction.bind(null, slug)} stages={stageOptions} />
              {addClass()}
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
              ? "Start with the usual Ghanaian levels, from Creche to JHS 3."
              : "Your school has not set up its classes yet."
          }
          action={
            canManage && (
              <SetupLevelsDialog action={setupLevelsAction.bind(null, slug)} stages={stageOptions} />
            )
          }
        />
      ) : (
        <div className="space-y-8">
          {levels.map((level) => (
            <section key={level.id} className="space-y-2" aria-labelledby={`level-${level.id}`}>
              <div className="flex items-center justify-between gap-3">
                <h2 id={`level-${level.id}`} className="text-md font-semibold text-ink">
                  {level.name}{" "}
                  <span className="text-sm font-normal text-ink-3">· {STAGE_LABELS[level.stage]}</span>
                </h2>
                {canManage && (
                  <div className="flex gap-1">
                    <RenameLevelDialog
                      action={renameLevelAction.bind(null, slug, level.id)}
                      name={level.name}
                    />
                    {addClass(level.id)}
                  </div>
                )}
              </div>
              {level.classes.length === 0 ? (
                <p className="text-sm text-ink-3">No classes yet.</p>
              ) : (
                <TableFrame>
                  <Table>
                    <caption className="sr-only">Classes in {level.name}</caption>
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
                    <TBody>
                      {level.classes.map((cls) => (
                        <TR key={cls.id}>
                          <TD>
                            <span className="font-medium text-ink">{cls.name}</span>
                            {/* On small screens the class teacher sits under the class name. */}
                            <span className="block text-sm text-ink-3 sm:hidden">
                              {cls.classTeacher?.name ?? "No class teacher"}
                            </span>
                          </TD>
                          {multiCampus && <TD className="hidden sm:table-cell">{cls.campusName}</TD>}
                          <TD className="hidden sm:table-cell">
                            {cls.classTeacher?.name ?? <span className="text-ink-3">Not assigned</span>}
                          </TD>
                          <TD className="hidden sm:table-cell">
                            {cls.status === "active" ? (
                              <StatusText tone="positive">Active</StatusText>
                            ) : (
                              <StatusText tone="neutral">Archived</StatusText>
                            )}
                          </TD>
                          {canManage && (
                            <TD className="text-right whitespace-nowrap">
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
                            </TD>
                          )}
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableFrame>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
