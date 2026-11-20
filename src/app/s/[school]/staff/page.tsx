import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { IdCard } from "lucide-react";
import { StatusText } from "@/components/ui/badge";
import { Button, buttonStyles } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { listCampuses } from "@/server/campuses/service";
import { db } from "@/server/db/client";
import { listStaff, listStaffLists } from "@/server/staff/records";
import { todayIn } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { EMPLOYMENT_TYPE_LABELS } from "@/lib/staff";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { createStaffAction } from "./actions";
import { AddStaffDialog } from "./staff-controls";
import { ExpandingSearch } from "@/components/ui/expanding-search";

export const metadata: Metadata = { title: "Staff" };

export default async function StaffPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  // Pages render alongside the layout, so each checks access itself too.
  if (!allowed(ctx, "staff.view")) notFound();
  const status = search.status === "left" || search.status === "all" ? search.status : "active";
  const canManage = allowed(ctx, "staff.manage");
  const [people, lists, campuses] = await Promise.all([
    listStaff(db(), ctx, { status, q: search.q }),
    listStaffLists(db(), ctx),
    listCampuses(db(), ctx),
  ]);
  const slug = ctx.tenant.slug;
  const options = {
    departments: lists.departments.filter((d) => !d.archived).map((d) => ({ value: d.id, label: d.name })),
    positions: lists.positions.filter((p) => !p.archived).map((p) => ({ value: p.id, label: p.name })),
    campuses: campuses
      .filter((c) => c.status === "active" && (ctx.campusIds === null || ctx.campusIds.includes(c.id)))
      .map((c) => ({ value: c.id, label: c.name })),
  };
  const filtered = Boolean(search.q) || status !== "active";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <form
          id="staff-filters"
          method="get"
          className="flex flex-col gap-2 sm:flex-row"
          role="search"
          aria-label="Find staff"
        >
          <label htmlFor="staff-status" className="sr-only">
            Status
          </label>
          <Select id="staff-status" name="status" defaultValue={status} className="sm:max-w-[10rem]">
            <option value="active">Working here</option>
            <option value="left">Left</option>
            <option value="all">Everyone</option>
          </Select>
          <Button type="submit" variant="secondary">
            Find
          </Button>
        </form>
        <div className="flex items-center justify-end gap-2">
          <ExpandingSearch
            form="staff-filters"
            defaultValue={search.q}
            placeholder="Name or staff number"
            label="Search by name or staff number"
            buttonLabel="Look up staff"
          />
          {canManage && ctx.campusIds === null && (
            <Link href={schoolPath(slug, "staff/import")} className={buttonStyles("secondary")}>
              Import from a spreadsheet
            </Link>
          )}
          {canManage && (
            <AddStaffDialog
              action={createStaffAction.bind(null, slug)}
              options={options}
              today={todayIn(ctx.tenant.timezone)}
            />
          )}
        </div>
      </div>

      {people.length === 0 ? (
        <EmptyState
          icon={<IdCard />}
          title={filtered ? "No one matches" : "No staff records yet"}
          description={
            filtered
              ? "Try another name, or look among everyone."
              : "Add the people who work at the school, including those without an EduBridge account."
          }
        />
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Staff of {ctx.tenant.name}</caption>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH className="hidden sm:table-cell">Position</TH>
                <TH className="hidden md:table-cell">Employment</TH>
                <TH className="hidden lg:table-cell">Phone</TH>
                <TH>Status</TH>
              </tr>
            </THead>
            <TBody>
              {people.map((p) => (
                <TR key={p.id}>
                  <TD>
                    <Link
                      href={`${schoolPath(slug, "staff")}/${p.id}` as Route}
                      className="font-medium text-ink hover:underline"
                    >
                      {p.name}
                    </Link>
                    <span className="block text-sm text-ink-3">
                      {p.staffNumber}
                      {p.department ? ` · ${p.department}` : ""}
                      {p.campus ? ` · ${p.campus}` : ""}
                    </span>
                  </TD>
                  <TD className="hidden sm:table-cell">
                    {p.position ?? <span className="text-ink-3">Not set</span>}
                  </TD>
                  <TD className="hidden md:table-cell">{EMPLOYMENT_TYPE_LABELS[p.employmentType]}</TD>
                  <TD className="hidden tabular-nums lg:table-cell">{p.phone ? formatPhone(p.phone) : ""}</TD>
                  <TD>
                    {p.status === "active" ? (
                      <StatusText tone="positive">Working here</StatusText>
                    ) : (
                      <StatusText tone="neutral">Left</StatusText>
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
