import type { Metadata } from "next";
import Link from "next/link";
import { Smartphone } from "lucide-react";
import { MobileMoneyStatus } from "@/components/fees/mobile-money-status";
import { Alert } from "@/components/ui/alert";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { buttonStyles } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import {
  listSchoolMobileMoneyRequests,
  MOBILE_MONEY_FILTERS,
  MOBILE_MONEY_PAGE_SIZE,
  mobileMoneySetup,
  type MobileMoneyFilter,
} from "@/server/mobile-money/requests";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { NETWORK_LABELS } from "@/lib/mobile-money";
import { formatCedis } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { markMobileMoneyReviewedAction } from "../actions";
import { ReviewDialog } from "./review-dialog";

export const metadata: Metadata = { title: "Fees · Mobile Money" };

type Search = { show?: string; page?: string };

const EMPTY: Record<MobileMoneyFilter, { title: string; description: string }> = {
  all: {
    title: "No Mobile Money requests yet",
    description: "Send a payment prompt from a student's page. Every prompt and its outcome is listed here.",
  },
  attention: {
    title: "Nothing to review",
    description: "Payments the network reports differently from what was requested appear here.",
  },
  waiting: { title: "Nothing waiting", description: "Every prompt has been answered." },
};

export default async function MobileMoneyPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<Search>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const filter = (MOBILE_MONEY_FILTERS as readonly string[]).includes(search.show ?? "")
    ? (search.show as MobileMoneyFilter)
    : "all";
  const page = Math.max(1, Math.min(10_000, Number.parseInt(search.page ?? "1", 10) || 1));
  const result = await listSchoolMobileMoneyRequests(db(), ctx, { filter, page });
  const setup = mobileMoneySetup(ctx);
  const canReview = allowed(ctx, "payments.record");
  const pages = Math.max(1, Math.ceil(result.total / MOBILE_MONEY_PAGE_SIZE));
  const href = (show: MobileMoneyFilter, p = 1) => {
    const qs = new URLSearchParams({
      ...(show !== "all" ? { show } : {}),
      ...(p > 1 ? { page: String(p) } : {}),
    });
    const query = qs.toString();
    return `${schoolPath(slug, "fees/mobile-money")}${query ? `?${query}` : ""}` as Parameters<
      typeof Link
    >[0]["href"];
  };
  const tabs: { show: MobileMoneyFilter; label: string }[] = [
    { show: "all", label: "All" },
    {
      show: "attention",
      label: result.attentionCount ? `Needs review (${result.attentionCount})` : "Needs review",
    },
    { show: "waiting", label: "Waiting" },
  ];

  return (
    <div className="space-y-6">
      {result.rows.some((r) => r.status === "pending") && <AutoRefresh />}
      {!setup.enabled ? (
        <Alert>
          Mobile Money is not set up for this school, so no new prompts can be sent. Earlier requests stay
          listed here.
        </Alert>
      ) : (
        setup.testMode && <Alert>{setup.testHint ?? "Test mode: no money moves."}</Alert>
      )}
      {result.attentionCount > 0 && filter !== "attention" && (
        <Alert tone="critical">
          {result.attentionCount === 1
            ? "1 payment is held because the network reported a different amount."
            : `${result.attentionCount} payments are held because the network reported a different amount.`}{" "}
          <Link href={href("attention")} className="font-medium underline">
            Review them
          </Link>
        </Alert>
      )}

      <nav aria-label="Show requests" className="flex flex-wrap gap-1">
        {tabs.map((t) => (
          <Link
            key={t.show}
            href={href(t.show)}
            aria-current={filter === t.show ? "page" : undefined}
            className={cn(buttonStyles(filter === t.show ? "secondary" : "ghost", "sm"))}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {result.rows.length === 0 ? (
        <EmptyState icon={<Smartphone />} {...EMPTY[filter]} />
      ) : (
        <>
          <TableFrame>
            <Table>
              <caption className="sr-only">Mobile Money requests</caption>
              <THead>
                <tr>
                  <TH className="hidden md:table-cell">Sent</TH>
                  <TH>Student</TH>
                  <TH className="text-right">Amount</TH>
                  <TH className="hidden xl:table-cell">Payer</TH>
                  <TH>Outcome</TH>
                </tr>
              </THead>
              <TBody>
                {result.rows.map((r) => (
                  <TR key={r.id}>
                    <TD className="hidden whitespace-nowrap md:table-cell">
                      {formatDateTime(r.createdAt, ctx.tenant.timezone)}
                      {r.requestedBy && <span className="block text-sm text-ink-3">{r.requestedBy}</span>}
                    </TD>
                    <TD className="whitespace-nowrap">
                      <Link
                        href={schoolPath(slug, `students/${r.studentId}`)}
                        className="font-medium text-ink hover:underline"
                      >
                        {r.studentName}
                      </Link>
                      <span className="block font-mono text-xs text-ink-3">{r.admissionNumber}</span>
                      <span className="block text-sm text-ink-3 md:hidden">
                        {formatDateTime(r.createdAt, ctx.tenant.timezone)}
                      </span>
                    </TD>
                    <TD className="text-right whitespace-nowrap tabular-nums">
                      {formatCedis(r.amountPesewas)}
                    </TD>
                    <TD className="hidden whitespace-nowrap xl:table-cell">
                      {formatPhone(r.msisdn)}
                      <span className="block text-sm text-ink-3">
                        {NETWORK_LABELS[r.network]}
                        {r.transactionId && ` · ${r.transactionId}`}
                      </span>
                    </TD>
                    <TD className="min-w-56 text-sm">
                      <MobileMoneyStatus slug={slug} request={r} />
                      {canReview && r.status === "needs_review" && !r.reviewedAt && (
                        <div className="mt-2">
                          <ReviewDialog
                            action={markMobileMoneyReviewedAction.bind(null, slug, r.id)}
                            summary={`${formatCedis(r.amountPesewas)} for ${r.studentName}`}
                          />
                        </div>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
          {pages > 1 && (
            <nav aria-label="Request pages" className="flex items-center justify-between text-sm text-ink-2">
              <span>
                Page {result.page} of {pages}
              </span>
              <span className="flex gap-2">
                {result.page > 1 && (
                  <Link href={href(filter, result.page - 1)} className={buttonStyles("secondary", "sm")}>
                    Previous
                  </Link>
                )}
                {result.page < pages && (
                  <Link href={href(filter, result.page + 1)} className={buttonStyles("secondary", "sm")}>
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
