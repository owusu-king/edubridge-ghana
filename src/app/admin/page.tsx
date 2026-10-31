import type { Metadata, Route } from "next";
import Link from "next/link";
import { Building2, Plus } from "lucide-react";
import { StatusText } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { SchoolMonogram } from "@/components/ui/monogram";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { db } from "@/server/db/client";
import { listSchools } from "@/server/platform/service";
import { countryName, formatDate } from "@/lib/format";
import { requirePlatformAdmin } from "@/web/auth";

export const metadata: Metadata = { title: "Schools" };

export default async function SchoolsAdminPage() {
  const user = await requirePlatformAdmin();
  const schools = await listSchools(db(), user.id);
  const newSchool = (
    <Link href={"/admin/schools/new" as Route} className={buttonStyles("primary", "md")}>
      <Plus aria-hidden="true" />
      New school
    </Link>
  );

  return (
    <div className="space-y-8">
      <PageHeader
        title="Schools"
        description={`${schools.length} ${schools.length === 1 ? "school" : "schools"} on EduBridge.`}
        actions={newSchool}
      />
      {schools.length === 0 ? (
        <EmptyState
          icon={<Building2 />}
          title="No schools yet"
          description="Create the first school to onboard its proprietor."
          action={newSchool}
        />
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Schools</caption>
            <THead>
              <tr>
                <TH>School</TH>
                <TH className="hidden md:table-cell">Country</TH>
                <TH className="hidden md:table-cell">Plan</TH>
                <TH>Status</TH>
                <TH className="hidden sm:table-cell" numeric>
                  Created
                </TH>
              </tr>
            </THead>
            <TBody>
              {schools.map((school) => (
                <TR key={school.id} className="relative">
                  <TD>
                    <div className="flex items-center gap-3">
                      <SchoolMonogram name={school.name} className="size-7 text-xs" />
                      <div className="min-w-0">
                        <Link
                          href={`/admin/schools/${school.id}` as Route}
                          className="font-medium text-ink after:absolute after:inset-0 hover:underline"
                        >
                          {school.name}
                        </Link>
                        <p className="truncate font-mono text-xs text-ink-3">/s/{school.slug}</p>
                      </div>
                    </div>
                  </TD>
                  <TD className="hidden md:table-cell">{countryName(school.countryCode)}</TD>
                  <TD className="hidden md:table-cell">
                    {school.planName ?? <span className="text-ink-3">Not set</span>}
                  </TD>
                  <TD>
                    {school.status === "active" ? (
                      <StatusText tone="positive">Active</StatusText>
                    ) : (
                      <StatusText tone="caution">Suspended</StatusText>
                    )}
                  </TD>
                  <TD className="hidden sm:table-cell" numeric>
                    {formatDate(school.createdAt, "Africa/Accra")}
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
