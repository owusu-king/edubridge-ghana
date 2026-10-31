import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Users } from "lucide-react";
import { Button, buttonStyles } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { can } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listClassOptions, listStudents, PAGE_SIZE } from "@/server/students/service";
import { formatPhone } from "@/lib/phone";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { addStudentAction } from "./actions";
import { AddStudentDialog } from "./student-forms";

export const metadata: Metadata = { title: "Students" };

type Search = { q?: string; class?: string; status?: string; page?: string };

export default async function StudentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<Search>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "students.view")) notFound();
  const status = search.status === "withdrawn" || search.status === "graduated" ? search.status : "active";
  const [result, classOptions] = await Promise.all([
    listStudents(db(), ctx, { q: search.q, classId: search.class, status, page: Number(search.page) || 1 }),
    listClassOptions(db(), ctx),
  ]);
  const slug = ctx.tenant.slug;
  const canManage = can(ctx.roles, "students.manage");
  const viewAll = can(ctx.roles, "students.view_all");
  const pages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const filtered = Boolean(search.q || search.class || status !== "active");
  const pageHref = (page: number) => {
    const qs = new URLSearchParams({
      ...(search.q ? { q: search.q } : {}),
      ...(search.class ? { class: search.class } : {}),
      ...(status !== "active" ? { status } : {}),
      page: String(page),
    });
    return `${schoolPath(slug, "students")}?${qs}` as Route;
  };
  const classes = classOptions.map((c) => ({ id: c.id, name: c.name }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Students"
        description={
          viewAll
            ? `${result.total} ${status} ${result.total === 1 ? "student" : "students"}${result.termName ? ` · Classes for ${result.termName}` : ""}`
            : "Students in the classes you teach."
        }
        actions={
          canManage && (
            <>
              <Link href={schoolPath(slug, "students/import")} className={buttonStyles("secondary")}>
                Import
              </Link>
              <AddStudentDialog
                action={addStudentAction.bind(null, slug)}
                classes={classes}
                defaultClassId={search.class}
              />
            </>
          )
        }
      />

      <form method="get" className="flex flex-col gap-2 sm:flex-row" role="search" aria-label="Find students">
        <label htmlFor="student-search" className="sr-only">
          Search by name or admission number
        </label>
        <Input
          id="student-search"
          name="q"
          type="search"
          defaultValue={search.q}
          placeholder="Name or admission number"
          className="sm:max-w-xs"
        />
        <label htmlFor="class-filter" className="sr-only">
          Class
        </label>
        <Select id="class-filter" name="class" defaultValue={search.class ?? ""} className="sm:max-w-[12rem]">
          <option value="">All classes</option>
          {viewAll && <option value="none">Not in a class</option>}
          {classOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        {viewAll && (
          <>
            <label htmlFor="status-filter" className="sr-only">
              Status
            </label>
            <Select id="status-filter" name="status" defaultValue={status} className="sm:max-w-[10rem]">
              <option value="active">Active</option>
              <option value="withdrawn">Withdrawn</option>
              <option value="graduated">Graduated</option>
            </Select>
          </>
        )}
        <Button type="submit" variant="secondary">
          Search
        </Button>
        {filtered && (
          <Link href={schoolPath(slug, "students")} className={buttonStyles("ghost")}>
            Clear
          </Link>
        )}
      </form>

      {result.rows.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title={filtered ? "No students match" : "No students yet"}
          description={
            filtered
              ? "Try another name, class or status."
              : canManage
                ? "Add your first student to get started."
                : "Students appear here once they are added to your classes."
          }
        />
      ) : (
        <>
          <TableFrame>
            <Table>
              <caption className="sr-only">Students</caption>
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH className="hidden sm:table-cell">Admission no.</TH>
                  <TH>Class</TH>
                  <TH className="hidden md:table-cell">Primary contact</TH>
                </tr>
              </THead>
              <TBody>
                {result.rows.map((s) => (
                  <TR key={s.id} className="relative">
                    <TD>
                      <Link
                        href={schoolPath(slug, `students/${s.id}`)}
                        className="font-medium text-ink after:absolute after:inset-0 hover:underline"
                      >
                        {s.fullName}
                      </Link>
                      <span className="block font-mono text-xs text-ink-3 sm:hidden">
                        {s.admissionNumber}
                      </span>
                    </TD>
                    <TD className="hidden font-mono text-sm sm:table-cell">{s.admissionNumber}</TD>
                    <TD>{s.className ?? <span className="text-ink-3">Not in a class</span>}</TD>
                    <TD className="hidden md:table-cell">
                      {s.primaryContact ? (
                        <>
                          {s.primaryContact.name}
                          {s.primaryContact.phone && (
                            <span className="block text-sm text-ink-3">
                              {formatPhone(s.primaryContact.phone)}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-ink-3">None recorded</span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
          {pages > 1 && (
            <nav aria-label="Student pages" className="flex items-center justify-between text-sm text-ink-2">
              <span>
                Page {result.page} of {pages}
              </span>
              <span className="flex gap-2">
                {result.page > 1 && (
                  <Link href={pageHref(result.page - 1)} className={buttonStyles("secondary", "sm")}>
                    Previous
                  </Link>
                )}
                {result.page < pages && (
                  <Link href={pageHref(result.page + 1)} className={buttonStyles("secondary", "sm")}>
                    Next
                  </Link>
                )}
              </span>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
