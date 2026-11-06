import type { Metadata } from "next";
import Link from "next/link";
import { HandCoins } from "lucide-react";
import { Button, buttonStyles } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { DescriptionList, EmptyState } from "@/components/ui/layout";
import { can } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listOwing, OWING_PAGE_SIZE } from "@/server/fees/owing";
import { listClassOptions } from "@/server/students/service";
import { feeReminderMessage, whatsappLink } from "@/lib/fee-messages";
import { balanceLinkUrl } from "@/server/notifications/templates";
import { todayIn } from "@/lib/format";
import { formatCedis, parseCedis } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { sendRemindersAction } from "./actions";
import { OwingTable } from "./owing-table";

export const metadata: Metadata = { title: "Fees · Owing" };

type Search = { class?: string; min?: string; overdue?: string; page?: string };

export default async function OwingPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<Search>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const classId = search.class && /^[0-9a-f-]{36}$/.test(search.class) ? search.class : undefined;
  // An amount that cannot be read is ignored (and shown back as typed) rather than failing the page.
  const min = search.min?.slice(0, 20) ?? "";
  const minAmount = min && parseCedis(min) !== null ? min : undefined;
  const overdueOnly = search.overdue === "1";
  const page = Math.max(1, Math.min(10_000, Number.parseInt(search.page ?? "1", 10) || 1));
  const [result, classOptions] = await Promise.all([
    listOwing(db(), ctx, { classId, minAmount, overdueOnly, page }),
    listClassOptions(db(), ctx),
  ]);
  const canRemind = can(ctx.roles, "fees.remind");
  const today = todayIn(ctx.tenant.timezone);
  const filtered = Boolean(classId || minAmount || overdueOnly);
  const pages = Math.max(1, Math.ceil(result.total / OWING_PAGE_SIZE));
  const pageHref = (p: number) => {
    const qs = new URLSearchParams({
      ...(classId ? { class: classId } : {}),
      ...(minAmount ? { min: minAmount } : {}),
      ...(overdueOnly ? { overdue: "1" } : {}),
      page: String(p),
    });
    return `${schoolPath(slug, "fees/owing")}?${qs.toString()}` as Parameters<typeof Link>[0]["href"];
  };

  return (
    <div className="space-y-6">
      <DescriptionList
        items={[
          { term: filtered ? "Students matching" : "Students owing", detail: String(result.total) },
          { term: filtered ? "Owed by them" : "Total owed", detail: formatCedis(result.owedPesewas) },
          {
            term: "No phone to remind",
            detail: result.withoutPhone ? String(result.withoutPhone) : "None",
          },
        ]}
      />

      <form
        method="get"
        className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center"
        role="search"
        aria-label="Filter students who owe"
      >
        <label htmlFor="owing-class" className="sr-only">
          Class
        </label>
        <Select id="owing-class" name="class" defaultValue={classId ?? ""} className="sm:max-w-[12rem]">
          <option value="">All classes</option>
          {classOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <label htmlFor="owing-min" className="sr-only">
          Owing at least (GH₵)
        </label>
        <Input
          id="owing-min"
          name="min"
          inputMode="decimal"
          defaultValue={min}
          placeholder="Owing at least (GH₵)"
          className="tabular-nums sm:max-w-[12rem]"
        />
        <label className="flex items-center gap-2 px-1 text-base text-ink">
          <input
            type="checkbox"
            name="overdue"
            value="1"
            defaultChecked={overdueOnly}
            className="size-4 accent-ink"
          />
          Behind on a payment plan
        </label>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
        {filtered && (
          <Link href={schoolPath(slug, "fees/owing")} className={buttonStyles("ghost")}>
            Clear
          </Link>
        )}
      </form>

      {result.rows.length === 0 ? (
        <EmptyState
          icon={<HandCoins />}
          title={filtered ? "No one matches" : "No one owes the school"}
          description={
            filtered
              ? "Try another class or a lower amount."
              : "Students appear here when their account shows an amount owed."
          }
        />
      ) : (
        <>
          <OwingTable
            canRemind={canRemind}
            today={today}
            schoolName={ctx.tenant.name}
            linkPreview={balanceLinkUrl("…")}
            send={sendRemindersAction.bind(null, slug)}
            rows={result.rows.map((r) => ({
              studentId: r.studentId,
              name: r.name,
              firstName: r.firstName,
              admissionNumber: r.admissionNumber,
              className: r.className,
              inactive: r.status === "active" ? null : r.status === "withdrawn" ? "Withdrawn" : "Graduated",
              balancePesewas: r.balancePesewas,
              overduePesewas: r.plan?.overduePesewas ?? 0,
              contactName: r.contact?.name ?? null,
              phone: r.contact?.phone ?? null,
              lastPaidOn: r.lastPaidOn,
              lastRemindedOn: r.lastRemindedOn,
              studentHref: schoolPath(slug, `students/${r.studentId}`),
              statementHref: schoolPath(slug, `students/${r.studentId}/statement`),
              whatsappHref: r.contact?.phone
                ? whatsappLink(
                    r.contact.phone,
                    feeReminderMessage({
                      schoolName: ctx.tenant.name,
                      studentName: r.name,
                      balancePesewas: r.balancePesewas,
                    }),
                  )
                : null,
            }))}
          />
          {pages > 1 && (
            <nav aria-label="Owing pages" className="flex items-center justify-between text-sm text-ink-2">
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
