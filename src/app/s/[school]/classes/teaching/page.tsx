import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Users } from "lucide-react";
import { ActionButton, ChoiceForm } from "@/components/ui/action-forms";
import { EmptyState, PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { listTeacherOptions } from "@/server/academics/classes";
import { getTeachingOverview } from "@/server/assessment/teaching";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { assignSubjectTeacherAction, removeSubjectTeacherAction, saveTeachingModelAction } from "./actions";
import { AssignSubjectTeacherForm } from "./assign-form";

export const metadata: Metadata = { title: "Teaching" };

const MODELS = [
  {
    value: "class",
    label: "Class teachers",
    description: "Each class teacher enters every subject's marks for their class.",
  },
  {
    value: "subject",
    label: "Subject teachers",
    description:
      "Subject teachers enter marks for the subjects they teach, in every class they teach them. Class teachers keep the register, remarks and report cards, and any subject without a subject teacher.",
  },
];

/** How teachers are assigned in this school, and who teaches which subject in which class. */
export default async function TeachingPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "classes.view")) notFound();
  const canManage = allowed(ctx, "academics.manage");
  const slug = ctx.tenant.slug;
  const [overview, teachers] = await Promise.all([
    getTeachingOverview(db(), ctx),
    canManage ? listTeacherOptions(db(), ctx) : Promise.resolve([]),
  ]);
  // One teacher, one subject, every class they teach it in: grouped so nothing reads as duplicated.
  const groups = new Map<
    string,
    { teacherName: string; subjectName: string; rows: typeof overview.assignments }
  >();
  for (const a of overview.assignments) {
    const key = `${a.membershipId}:${a.subjectId}`;
    const group = groups.get(key) ?? { teacherName: a.teacherName, subjectName: a.subjectName, rows: [] };
    group.rows.push(a);
    groups.set(key, group);
  }

  return (
    <div className="space-y-10">
      <div>
        <Link
          href={schoolPath(slug, "classes") as Route}
          className="-ml-2 inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm text-ink-2 hover:text-ink"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Classes
        </Link>
        <PageHeader
          title="Teaching"
          description="Who enters marks: class teachers for their whole class, or subject teachers for their subjects."
        />
      </div>

      <Section title="How teachers are assigned">
        {canManage ? (
          <ChoiceForm
            action={saveTeachingModelAction.bind(null, slug)}
            name="teachingModel"
            label="Teaching model"
            value={overview.model}
            options={MODELS}
          />
        ) : (
          <p className="text-base text-ink-2">
            {MODELS.find((m) => m.value === overview.model)?.description}
          </p>
        )}
      </Section>

      <Section
        title="Subject teachers"
        description={
          overview.model === "subject"
            ? "Give a teacher a subject in one or more classes. A class keeps one teacher per subject."
            : "Kept for when the school teaches by subject. While class teachers enter all marks, these have no effect."
        }
      >
        {canManage && (
          <AssignSubjectTeacherForm
            action={assignSubjectTeacherAction.bind(null, slug)}
            teachers={teachers.map((t) => ({ value: t.membershipId, label: t.name }))}
            subjects={overview.subjects.map((s) => ({ value: s.id, label: s.name }))}
            classes={overview.classes.map((c) => ({ value: c.id, label: c.name, subjectIds: c.subjectIds }))}
            taken={overview.assignments.map((a) => ({
              classId: a.classId,
              subjectId: a.subjectId,
              teacher: a.teacherName,
            }))}
          />
        )}
        {groups.size === 0 ? (
          <EmptyState
            icon={<Users />}
            title="No subject teachers yet"
            description={
              overview.subjects.length === 0
                ? "Set up subjects under Assessment, Setup first."
                : "Assign a teacher to a subject and the classes they teach it in."
            }
          />
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Subject teachers</caption>
              <THead>
                <tr>
                  <TH>Teacher</TH>
                  <TH>Subject</TH>
                  <TH>Classes</TH>
                </tr>
              </THead>
              <TBody>
                {[...groups.values()].map((g) => (
                  <TR key={`${g.teacherName}:${g.subjectName}`}>
                    <TD className="font-medium text-ink">{g.teacherName}</TD>
                    <TD>{g.subjectName}</TD>
                    <TD>
                      <ul className="flex flex-wrap gap-x-4 gap-y-1">
                        {g.rows.map((r) => (
                          <li key={r.id} className="flex items-center gap-1">
                            <span>{r.className}</span>
                            {canManage && (
                              <ActionButton
                                action={removeSubjectTeacherAction.bind(null, slug, r.id)}
                                label="Remove"
                                variant="danger-outline"
                                ariaLabel={`Remove ${g.teacherName} from ${g.subjectName} in ${r.className}`}
                              />
                            )}
                          </li>
                        ))}
                      </ul>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>
    </div>
  );
}
