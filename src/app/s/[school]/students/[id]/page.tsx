import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { StatusText } from "@/components/ui/badge";
import { DescriptionList, PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { can } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getStudent, listClassOptions } from "@/server/students/service";
import { formatCalendarDate } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { assignClassAction, setStudentStatusAction, updateStudentAction } from "../actions";
import { ChangeClassDialog, EditStudentDialog, StatusDialog } from "../student-forms";

export const metadata: Metadata = { title: "Student" };

const STATUS = {
  active: <StatusText tone="positive">Active</StatusText>,
  withdrawn: <StatusText tone="neutral">Withdrawn</StatusText>,
  graduated: <StatusText tone="neutral">Graduated</StatusText>,
};

export default async function StudentPage({ params }: { params: Promise<{ school: string; id: string }> }) {
  const { school, id } = await params;
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "students.view")) notFound();
  const student = await getStudent(db(), ctx, id);
  if (!student) notFound();
  const slug = ctx.tenant.slug;
  const canManage = can(ctx.roles, "students.manage");
  const classes = canManage
    ? (await listClassOptions(db(), ctx)).map((c) => ({ id: c.id, name: c.name }))
    : [];

  return (
    <div className="space-y-10">
      <div className="space-y-4">
        <Link
          href={schoolPath(slug, "students")}
          className="inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Students
        </Link>
        <PageHeader
          title={student.fullName}
          description={
            <span className="inline-flex flex-wrap items-center gap-3">
              <span className="font-mono text-sm">{student.admissionNumber}</span>
              {STATUS[student.status]}
            </span>
          }
          actions={
            canManage && (
              <>
                <EditStudentDialog
                  action={updateStudentAction.bind(null, slug, student.id)}
                  defaults={student}
                />
                <StatusDialog
                  action={setStudentStatusAction.bind(
                    null,
                    slug,
                    student.id,
                    student.status === "active" ? "withdrawn" : "active",
                  )}
                  status={student.status}
                  name={student.fullName}
                />
              </>
            )
          }
        />
      </div>

      <div className="grid gap-10 lg:grid-cols-[1fr_20rem]">
        <Section
          title="Class"
          aside={
            canManage &&
            student.status === "active" &&
            classes.length > 0 && (
              <ChangeClassDialog
                action={assignClassAction.bind(null, slug, student.id)}
                classes={classes}
                currentClassId={student.currentClass?.id}
              />
            )
          }
        >
          <p className="text-base text-ink">
            {student.currentClass?.name ?? <span className="text-ink-3">Not in a class this term</span>}
          </p>
          {student.history.length > 0 && (
            <TableFrame>
              <Table>
                <caption className="sr-only">Class history</caption>
                <THead>
                  <tr>
                    <TH>Term</TH>
                    <TH>Class</TH>
                  </tr>
                </THead>
                <TBody>
                  {student.history.map((h) => (
                    <TR key={`${h.yearName}-${h.termName}`}>
                      <TD>
                        {h.termName}, {h.yearName}
                      </TD>
                      <TD className="text-ink">{h.className}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
        </Section>
        <Section title="Details">
          <DescriptionList
            stacked
            items={[
              { term: "Sex", detail: student.sex === "female" ? "Female" : "Male" },
              {
                term: "Date of birth",
                detail: student.dateOfBirth ? (
                  formatCalendarDate(student.dateOfBirth)
                ) : (
                  <span className="text-ink-3">Not recorded</span>
                ),
              },
              {
                term: "Admitted",
                detail: student.admittedOn ? (
                  formatCalendarDate(student.admittedOn)
                ) : (
                  <span className="text-ink-3">Not recorded</span>
                ),
              },
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
