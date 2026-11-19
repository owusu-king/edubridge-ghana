import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DoorOpen } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { ActionButton } from "@/components/ui/action-forms";
import { buttonStyles } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { EmptyState, PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listOnSite, listVisitorOptions, listVisitsOn, type Visit } from "@/server/visitors/visits";
import { formatCalendarDate, formatDateTime, formatTime, todayIn } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { VISIT_PURPOSE_LABELS } from "@/lib/visitors";
import { requireTenant } from "@/web/auth";
import { signInVisitorAction, signOutVisitorAction } from "./actions";
import { SignInDialog } from "./visitors-controls";

export const metadata: Metadata = { title: "Visitors" };

/** Visitors on site now, signing in and out, and the log for any day (VIS-01). */
export default async function VisitorsPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "visitors.view")) notFound();
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const today = todayIn(tz);
  const asked = (await searchParams).date;
  const day = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= today ? asked : today;
  const manage = allowed(ctx, "visitors.manage");
  const [onSite, log, options] = await Promise.all([
    listOnSite(db(), ctx),
    listVisitsOn(db(), ctx, day),
    manage ? listVisitorOptions(db(), ctx) : null,
  ]);

  const who = (v: Visit) => (
    <>
      <span className="font-medium text-ink">{v.fullName}</span>
      <span className="block text-sm text-ink-3">
        {[v.organisation, v.phone && formatPhone(v.phone)].filter(Boolean).join(" · ") || " "}
      </span>
    </>
  );

  return (
    <div className="space-y-10">
      <PageHeader
        title="Visitors"
        description="Sign visitors in when they arrive and out when they leave, so the school always knows who is on site."
        actions={
          options && (
            <SignInDialog
              action={signInVisitorAction.bind(null, slug)}
              hosts={options.hosts}
              campuses={options.campuses}
            />
          )
        }
      />
      {ctx.modules.visitors_pickup?.state === "read_only" && (
        <Alert tone="info">
          Visitors and pickup has ended for this school. The records can be viewed and exported, but nobody
          can be signed in or out. Ask EduBridge to add it again to carry on.
        </Alert>
      )}

      <Section
        title="On site now"
        description={onSite.length ? `${onSite.length} signed in and not out.` : undefined}
      >
        {onSite.length === 0 ? (
          <EmptyState
            icon={<DoorOpen />}
            title="Nobody signed in"
            description="Visitors appear here from when they are signed in until they are signed out."
          />
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Visitors on site now</caption>
              <THead>
                <tr>
                  <TH>Visitor</TH>
                  <TH className="hidden sm:table-cell">Purpose</TH>
                  <TH className="hidden md:table-cell">Visiting</TH>
                  <TH>Arrived</TH>
                  {manage && (
                    <TH>
                      <span className="sr-only">Sign out</span>
                    </TH>
                  )}
                </tr>
              </THead>
              <TBody>
                {onSite.map((v) => {
                  const earlier = todayIn(tz, v.signedInAt) !== today;
                  return (
                    <TR key={v.id}>
                      <TD>{who(v)}</TD>
                      <TD className="hidden sm:table-cell">{VISIT_PURPOSE_LABELS[v.purpose]}</TD>
                      <TD className="hidden md:table-cell">{v.visiting ?? "—"}</TD>
                      <TD>
                        {earlier ? (
                          <span className="text-caution">
                            {formatDateTime(v.signedInAt, tz)}
                            <span className="block text-sm">Not signed out</span>
                          </span>
                        ) : (
                          formatTime(v.signedInAt, tz)
                        )}
                        {v.badge && <span className="block text-sm text-ink-3">Badge {v.badge}</span>}
                      </TD>
                      {manage && (
                        <TD className="text-right">
                          <ActionButton
                            action={signOutVisitorAction.bind(null, slug, v.id)}
                            label="Sign out"
                            ariaLabel={`Sign out ${v.fullName}`}
                          />
                        </TD>
                      )}
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>

      <Section title="Visitor log" description="Everyone signed in on a day, with when they left.">
        <form method="get" className="flex items-end gap-2" aria-label="Choose day">
          <div className="space-y-1.5">
            <label htmlFor="visitors-date" className="block text-sm font-medium text-ink">
              Day
            </label>
            <Input
              id="visitors-date"
              type="date"
              name="date"
              defaultValue={day}
              max={today}
              className="w-44"
            />
          </div>
          <button type="submit" className={buttonStyles("secondary")}>
            Show
          </button>
        </form>
        {log.length === 0 ? (
          <p className="text-base text-ink-3">
            No visitors on {formatCalendarDate(day)}
            {day === today ? " (today)" : ""}.
          </p>
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Visitor log, {formatCalendarDate(day)}</caption>
              <THead>
                <tr>
                  <TH>Visitor</TH>
                  <TH className="hidden sm:table-cell">Purpose</TH>
                  <TH className="hidden md:table-cell">Visiting</TH>
                  <TH>In</TH>
                  <TH>Out</TH>
                  <TH className="hidden lg:table-cell">Signed in by</TH>
                </tr>
              </THead>
              <TBody>
                {log.map((v) => (
                  <TR key={v.id}>
                    <TD>{who(v)}</TD>
                    <TD className="hidden sm:table-cell">
                      {VISIT_PURPOSE_LABELS[v.purpose]}
                      {v.note && <span className="block text-sm text-ink-3">{v.note}</span>}
                    </TD>
                    <TD className="hidden md:table-cell">
                      {v.visiting ?? "—"}
                      {v.campus && <span className="block text-sm text-ink-3">{v.campus}</span>}
                    </TD>
                    <TD>{formatTime(v.signedInAt, tz)}</TD>
                    <TD>
                      {v.signedOutAt ? (
                        todayIn(tz, v.signedOutAt) === todayIn(tz, v.signedInAt) ? (
                          formatTime(v.signedOutAt, tz)
                        ) : (
                          formatDateTime(v.signedOutAt, tz)
                        )
                      ) : (
                        <span className="text-ink-3">Not yet</span>
                      )}
                    </TD>
                    <TD className="hidden lg:table-cell">{v.signedInBy}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>
    </div>
  );
}
