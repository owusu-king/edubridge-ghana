import type { Metadata } from "next";
import Link from "next/link";
import { Users } from "lucide-react";
import { Button, buttonStyles } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { DescriptionList, EmptyState } from "@/components/ui/layout";
import { PageNav } from "@/components/ui/page-nav";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { ACCOUNTS_PAGE_SIZE, listAccounts } from "@/server/fees/payments";
import { listClassOptions } from "@/server/students/service";
import { moneyFormatter } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { ExpandingSearch } from "@/components/ui/expanding-search";

export const metadata: Metadata = { title: "Fees · Accounts" };

type Search = { q?: string; class?: string; owing?: string; page?: string };

function Balance({ pesewas, showMoney }: { pesewas: number; showMoney: (minor: number) => string }) {
  if (pesewas > 0) return <span className="font-medium text-ink">{showMoney(pesewas)}</span>;
  if (pesewas < 0) return <span className="text-ink-2">{showMoney(-pesewas)} credit</span>;
  return <span className="text-ink-3">Paid up</span>;
}

export default async function AccountsPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<Search>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  const showMoney = moneyFormatter(ctx.tenant.currencyCode);
  const slug = ctx.tenant.slug;
  const classId = search.class && /^[0-9a-f-]{36}$/.test(search.class) ? search.class : undefined;
  const owing = search.owing === "1";
  const page = Math.max(1, Math.min(10_000, Number.parseInt(search.page ?? "1", 10) || 1));
  const [result, classOptions] = await Promise.all([
    listAccounts(db(), ctx, { q: search.q?.slice(0, 60) || undefined, classId, owing, page }),
    listClassOptions(db(), ctx),
  ]);
  const pages = Math.max(1, Math.ceil(result.total / ACCOUNTS_PAGE_SIZE));
  const filtered = Boolean(search.q || classId || owing);
  const pageHref = (p: number) => {
    const qs = new URLSearchParams({
      ...(search.q ? { q: search.q } : {}),
      ...(classId ? { class: classId } : {}),
      ...(owing ? { owing: "1" } : {}),
      page: String(p),
    });
    return `${schoolPath(slug, "fees/accounts")}?${qs.toString()}` as Parameters<typeof Link>[0]["href"];
  };

  const canImport = allowed(ctx, "fees.manage") && ctx.campusIds === null;

  return (
    <div className="space-y-6">
      <div className="flex justify-end gap-2">
        <ExpandingSearch
          form="account-filters"
          defaultValue={search.q}
          placeholder="Name or admission number"
          label="Search by name or admission number"
          buttonLabel="Find accounts"
        />
        {canImport && (
          <Link href={schoolPath(slug, "fees/opening-balances")} className={buttonStyles("secondary")}>
            Import opening balances
          </Link>
        )}
      </div>
      <DescriptionList
        items={[
          {
            term: filtered ? "Owed by these students" : "Owed to the school",
            detail: showMoney(result.owedPesewas),
          },
          { term: "Paid in advance", detail: showMoney(result.creditPesewas) },
        ]}
      />

      <form
        id="account-filters"
        method="get"
        className="flex flex-col gap-2 sm:flex-row sm:items-center"
        role="search"
        aria-label="Find accounts"
      >
        <label htmlFor="account-class" className="sr-only">
          Class
        </label>
        <Select id="account-class" name="class" defaultValue={classId ?? ""} className="sm:max-w-[12rem]">
          <option value="">All classes</option>
          {classOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 px-1 text-base text-ink">
          <input
            type="checkbox"
            name="owing"
            value="1"
            defaultChecked={owing}
            className="size-4 accent-ink"
          />
          Owing only
        </label>
        <Button type="submit" variant="secondary">
          Search
        </Button>
        {filtered && (
          <Link href={schoolPath(slug, "fees/accounts")} className={buttonStyles("ghost")}>
            Clear
          </Link>
        )}
      </form>

      {result.rows.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title={filtered ? "No accounts match" : "No students yet"}
          description={filtered ? "Try another name or class." : "Accounts appear once students are added."}
        />
      ) : (
        <>
          <TableFrame>
            <Table>
              <caption className="sr-only">Student balances</caption>
              <THead>
                <tr>
                  <TH>Student</TH>
                  <TH className="hidden sm:table-cell">Class</TH>
                  <TH className="text-right">Balance</TH>
                </tr>
              </THead>
              <TBody>
                {result.rows.map((row) => (
                  <TR key={row.studentId} className="relative">
                    <TD>
                      <Link
                        href={schoolPath(slug, `students/${row.studentId}`)}
                        className="font-medium text-ink after:absolute after:inset-0 hover:underline"
                      >
                        {row.name}
                      </Link>
                      <span className="block font-mono text-xs text-ink-3">
                        {row.admissionNumber}
                        {row.status !== "active" &&
                          ` · ${row.status === "withdrawn" ? "Withdrawn" : "Graduated"}`}
                      </span>
                      <span className="block text-sm text-ink-3 sm:hidden">
                        {row.className ?? "Not in a class"}
                      </span>
                    </TD>
                    <TD className="hidden sm:table-cell">
                      {row.className ?? <span className="text-ink-3">Not in a class</span>}
                    </TD>
                    <TD className="text-right whitespace-nowrap tabular-nums">
                      <Balance showMoney={showMoney} pesewas={row.balancePesewas} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
          <PageNav label="Account pages" page={result.page} pages={pages} href={pageHref} />
        </>
      )}
    </div>
  );
}
