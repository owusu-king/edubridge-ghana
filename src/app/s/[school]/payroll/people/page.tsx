import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { IdCard } from "lucide-react";
import { EmptyState } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listStaffPay } from "@/server/payroll/service";
import { moneyFormatter } from "@/lib/money";
import { monthLabel } from "@/lib/plan";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";

export const metadata: Metadata = { title: "Salaries" };

/** Everyone working this month and the salary in force (PRL-01b). */
export default async function SalariesPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "payroll.view")) notFound();
  const people = await listStaffPay(db(), ctx);
  const money = moneyFormatter(ctx.tenant.currencyCode);
  const base = schoolPath(ctx.tenant.slug, "payroll/people");

  if (!people.length)
    return (
      <EmptyState
        icon={<IdCard />}
        title="No staff yet"
        description="Add staff under Staff first; their salaries are set here."
      />
    );
  return (
    <TableFrame>
      <Table>
        <caption className="sr-only">Salaries this month</caption>
        <THead>
          <tr>
            <TH>Name</TH>
            <TH numeric>Basic a month</TH>
            <TH className="hidden sm:table-cell">Since</TH>
          </tr>
        </THead>
        <TBody>
          {people.map((p) => (
            <TR key={p.staffId}>
              <TD>
                <Link href={`${base}/${p.staffId}` as Route} className="font-medium text-ink hover:underline">
                  {p.name}
                </Link>
                <span className="block text-sm text-ink-3">
                  {[p.staffNumber, p.position].filter(Boolean).join(" · ")}
                </span>
              </TD>
              <TD numeric>
                {p.salary ? money(p.salary.basic) : <span className="text-critical">No salary</span>}
              </TD>
              <TD className="hidden sm:table-cell">{p.salary ? monthLabel(p.salary.effectiveMonth) : ""}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </TableFrame>
  );
}
