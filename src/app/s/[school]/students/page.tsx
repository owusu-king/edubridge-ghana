import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Users } from "lucide-react";
import { Button, buttonStyles } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { PageNav } from "@/components/ui/page-nav";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listClassOptions, listStudents, PAGE_SIZE } from "@/server/students/service";
import { formatPhone } from "@/lib/phone";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { registerStudentAction } from "./actions";
import { AddStudentDialog } from "./student-forms";
import { ExpandingSearch } from "@/components/ui/expanding-search";

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
  if (!allowed(ctx, "students.view")) notFound();
  const status = search.status === "withdrawn" || search.status === "graduated" ? search.status : "active";
  const [result, classOptions] = await Promise.all([
    listStudents(db(), ctx, { q: search.q, classId: search.class, status, page: Number(search.page) || 1 }),
    listClassOptions(db(), ctx),
  ]);
  const slug = ctx.tenant.slug;
  const canManage = allowed(ctx, "students.manage");
  const viewAll = allowed(ctx, "students.view_all");
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
          <>
            <ExpandingSearch
              form="student-filters"
              defaultValue={search.q}
              placeholder="Name or admission number"
              label="Search by name or admission number"
              buttonLabel="Find students"
            />
            {canManage && (
              <>
                <Link href={schoolPath(slug, "students/import")} className={buttonStyles("secondary")}>
                  Import
                </Link>
                {allowed(ctx, "transfers.manage") && (
                  <Link href={schoolPath(slug, "students/transfers")} className={buttonStyles("secondary")}>
                    Transfers
                  </Link>
                )}
                <AddStudentDialog
                  action={registerStudentAction.bind(null, slug)}
                  classes={classOptions.map((c) => ({ id: c.id, name: c.name }))}
                  defaultClassId={classOptions.some((c) => c.id === search.class) ? search.class : undefined}
                  registerHref={`${schoolPath(slug, "students/register")}${search.class ? `?class=${encodeURIComponent(search.class)}` : ""}`}
                />
              </>
            )}
          </>
        }
      />

      <form
        id="student-filters"
        method="get"
        className="flex flex-col gap-2 sm:flex-row"
        role="search"
        aria-label="Find students"
      >
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
          <PageNav label="Student pages" page={result.page} pages={pages} href={pageHref} />
        </>
      )}
    </div>
  );
}
