import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/ui/action-forms";
import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { listBoarders, listExeats } from "@/server/boarding/boarders";
import { db } from "@/server/db/client";
import { formatCalendarDate, formatDateTime, todayIn } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { signInAction, signOutAction } from "../actions";
import { ExeatDialog } from "../boarding-controls";

export const metadata: Metadata = { title: "Boarding · Exeats" };

/** Boarders away on exeat now (overdue first), and the last 30 days (BRD-03). */
export default async function ExeatsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "boarding.view")) notFound();
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const exeat = allowed(ctx, "boarding.exeat");
  const [{ out, recent }, boarders] = await Promise.all([
    listExeats(db(), ctx),
    exeat ? listBoarders(db(), ctx) : Promise.resolve([]),
  ]);
  const overdue = out.filter((e) => e.overdueDays > 0).length;

  return (
    <div className="space-y-10">
      <Section
        title="Out now"
        description={
          out.length ? `${out.length} out${overdue ? `, ${overdue} overdue` : ""}.` : "Every boarder is in."
        }
        aside={
          exeat && boarders.length > 0 ? (
            <ExeatDialog
              action={signOutAction.bind(null, slug)}
              boarders={boarders.filter((b) => !out.some((e) => e.studentId === b.id))}
              today={todayIn(tz)}
            />
          ) : undefined
        }
      >
        {out.length > 0 && (
          <TableFrame>
            <Table>
              <caption className="sr-only">Boarders out on exeat</caption>
              <THead>
                <tr>
                  <TH>Boarder</TH>
                  <TH className="hidden md:table-cell">Why</TH>
                  <TH>Due back</TH>
                  {exeat && (
                    <TH>
                      <span className="sr-only">Sign in</span>
                    </TH>
                  )}
                </tr>
              </THead>
              <TBody>
                {out.map((e) => (
                  <TR key={e.id}>
                    <TD>
                      <span className="font-medium text-ink">{e.student}</span>
                      <span className="block text-sm text-ink-3">
                        {e.house} · out {formatDateTime(e.outAt, tz)}
                      </span>
                    </TD>
                    <TD className="hidden md:table-cell">
                      {e.reason}
                      <span className="block text-sm text-ink-3">With {e.collectedBy}</span>
                    </TD>
                    <TD>
                      {e.overdueDays > 0 ? (
                        <StatusText tone="critical">
                          {e.overdueDays} {e.overdueDays === 1 ? "day" : "days"} late
                        </StatusText>
                      ) : (
                        formatCalendarDate(e.expectedBackOn)
                      )}
                    </TD>
                    {exeat && (
                      <TD className="text-right">
                        <ActionButton
                          action={signInAction.bind(null, slug, e.id)}
                          label="Back in"
                          ariaLabel={`Sign ${e.student} back in`}
                        />
                      </TD>
                    )}
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>

      {recent.length > 0 && (
        <Section title="Back in the last 30 days">
          <ul className="divide-y divide-line border-y border-line">
            {recent.map((e) => (
              <li key={e.id} className="py-2.5 text-base text-ink">
                {e.student} · {e.house}
                <span className="block text-sm text-ink-3">
                  Out {formatDateTime(e.outAt, tz)}, back {formatDateTime(e.backAt!, tz)} · {e.reason}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
