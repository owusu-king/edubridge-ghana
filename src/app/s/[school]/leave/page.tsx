import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusText } from "@/components/ui/badge";
import { ActionButton } from "@/components/ui/action-forms";
import { PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getLeaveOverview, getMyLeave, type LeaveRow } from "@/server/staff/leave";
import { formatCalendarDate, formatDateTime, todayIn } from "@/lib/format";
import { LEAVE_STATUS_LABELS } from "@/lib/staff";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { cancelLeaveAction, decideLeaveAction, requestLeaveAction } from "./actions";
import { AskLeaveDialog, DecideLeaveDialogs } from "./leave-controls";

export const metadata: Metadata = { title: "Leave" };

const TONE = { pending: "caution", approved: "positive", declined: "neutral", cancelled: "neutral" } as const;
const dates = (l: { startsOn: string; endsOn: string }) =>
  l.startsOn === l.endsOn
    ? formatCalendarDate(l.startsOn)
    : `${formatCalendarDate(l.startsOn)} to ${formatCalendarDate(l.endsOn)}`;

/** Leave (HR-03): one's own leave and balances, and for approvers the requests waiting and who is away. */
export default async function LeavePage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "leave.request")) notFound();
  const approver = allowed(ctx, "leave.approve");
  const [mine, overview] = await Promise.all([
    getMyLeave(db(), ctx),
    approver ? getLeaveOverview(db(), ctx) : null,
  ]);
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const today = todayIn(tz);
  const types = mine.types.filter((t) => !t.archived).map((t) => ({ value: t.id, label: t.name }));
  const staffLink = (l: LeaveRow) =>
    allowed(ctx, "staff.view") ? (
      <Link
        href={`${schoolPath(slug, "staff")}/${l.staffId}` as Route}
        className="font-medium text-ink hover:underline"
      >
        {l.staffName}
      </Link>
    ) : (
      <span className="font-medium text-ink">{l.staffName}</span>
    );

  return (
    <div className="space-y-10">
      <PageHeader
        title="Leave"
        description={
          approver
            ? "Your own leave, the requests waiting for a decision and who is away."
            : "Your leave and what is left this year."
        }
        actions={
          mine.staff &&
          types.length > 0 && (
            <AskLeaveDialog action={requestLeaveAction.bind(null, slug)} types={types} today={today} />
          )
        }
      />

      {overview && (
        <>
          <Section title="Waiting for a decision" description="You cannot decide your own leave.">
            {overview.waiting.length === 0 ? (
              <p className="text-base text-ink-3">Nothing waiting.</p>
            ) : (
              <ul className="divide-y divide-line border-y border-line">
                {overview.waiting.map((l) => (
                  <li
                    key={l.id}
                    className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="min-w-0 space-y-0.5">
                      {staffLink(l)}
                      <p className="text-base text-ink-2">
                        {l.type}, {dates(l)} · {l.days} {l.days === 1 ? "day" : "days"}
                        {l.overBalance ? (
                          <span className="text-critical"> · {l.overBalance} beyond the allowance</span>
                        ) : null}
                      </p>
                      {l.reason && <p className="text-sm text-ink-2">“{l.reason}”</p>}
                      <p className="text-sm text-ink-3">Asked {formatDateTime(l.createdAt, tz)}</p>
                    </div>
                    <DecideLeaveDialogs
                      approve={decideLeaveAction.bind(null, slug, l.id, true)}
                      decline={decideLeaveAction.bind(null, slug, l.id, false)}
                      name={l.staffName}
                      overBalance={l.overBalance}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <div className="grid gap-10 lg:grid-cols-2">
            <Section title="Away today">
              {overview.awayToday.length === 0 ? (
                <p className="text-base text-ink-3">No one is on leave today.</p>
              ) : (
                <ul className="divide-y divide-line border-y border-line">
                  {overview.awayToday.map((l) => (
                    <li key={l.id} className="py-2.5">
                      {staffLink(l)}
                      <span className="block text-sm text-ink-3">
                        {l.type}, back after {formatCalendarDate(l.endsOn)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <Section title="Next 30 days">
              {overview.upcoming.length === 0 ? (
                <p className="text-base text-ink-3">No approved leave coming up.</p>
              ) : (
                <ul className="divide-y divide-line border-y border-line">
                  {overview.upcoming.map((l) => (
                    <li key={l.id} className="flex items-start justify-between gap-3 py-2.5">
                      <span>
                        {staffLink(l)}
                        <span className="block text-sm text-ink-3">
                          {l.type}, {dates(l)}
                        </span>
                      </span>
                      <ActionButton
                        action={cancelLeaveAction.bind(null, slug, l.id)}
                        label="Cancel"
                        variant="danger-outline"
                        ariaLabel={`Cancel leave for ${l.staffName}`}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        </>
      )}

      <Section title={`Your leave in ${mine.year}`}>
        {!mine.staff ? (
          <p className="text-base text-ink-3">
            You have no staff record at {ctx.tenant.name} yet, so you cannot ask for leave here. Ask the
            office to add one and link it to your account.
          </p>
        ) : types.length === 0 ? (
          <p className="text-base text-ink-3">The school has not set up leave types yet.</p>
        ) : (
          <>
            <ul className="grid gap-3 sm:grid-cols-3">
              {mine.balances.map((b) => (
                <li key={b.leaveTypeId} className="rounded-lg border border-line px-4 py-3">
                  <p className="text-sm text-ink-3">{b.name}</p>
                  <p className="tabular text-lg font-semibold text-ink">
                    {b.left === null ? `${b.taken} taken` : `${b.left} of ${b.allowed} left`}
                  </p>
                </li>
              ))}
            </ul>
            {mine.requests.length > 0 && (
              <TableFrame>
                <Table>
                  <caption className="sr-only">Your leave requests</caption>
                  <THead>
                    <tr>
                      <TH>Leave</TH>
                      <TH>Dates</TH>
                      <TH numeric>Days</TH>
                      <TH>Status</TH>
                      <TH>
                        <span className="sr-only">Actions</span>
                      </TH>
                    </tr>
                  </THead>
                  <TBody>
                    {mine.requests.map((l) => (
                      <TR key={l.id}>
                        <TD>{l.type}</TD>
                        <TD>{dates(l)}</TD>
                        <TD numeric>{l.days}</TD>
                        <TD>
                          <StatusText tone={TONE[l.status]}>{LEAVE_STATUS_LABELS[l.status]}</StatusText>
                          {l.decisionNote && (
                            <span className="block text-sm text-ink-3">{l.decisionNote}</span>
                          )}
                        </TD>
                        <TD className="text-right">
                          {(l.status === "pending" || (l.status === "approved" && l.startsOn > today)) && (
                            <ActionButton
                              action={cancelLeaveAction.bind(null, slug, l.id)}
                              label="Cancel"
                              variant="danger-outline"
                              ariaLabel={`Cancel ${l.type}, ${dates(l)}`}
                            />
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableFrame>
            )}
          </>
        )}
      </Section>
    </div>
  );
}
