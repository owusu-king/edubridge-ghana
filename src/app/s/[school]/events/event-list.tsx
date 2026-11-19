import type { Route } from "next";
import Link from "next/link";
import { CalendarDays } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listEvents, type EventRow } from "@/server/events/events";
import type { CalendarEntry } from "@/server/events/roster";
import { listAudiences } from "@/server/messages/announcements";
import type { TenantContext } from "@/server/tenancy/service";
import { formatDateTime } from "@/lib/format";
import { formatEventWhen, monthOf } from "@/lib/events";
import { schoolPath } from "@/lib/routes";
import { cancelEventAction, createEventAction, updateEventAction } from "./actions";
import { CancelEventDialog, EditEventDialog, NewEventDialog, type AudienceChoice } from "./event-controls";

function reminderText(e: EventRow): string | null {
  if (e.reminder === "none") return null;
  if (e.remindedAt)
    return `Reminded ${e.reminderPushCount} by notification${e.reminder === "sms" ? `, ${e.reminderSmsCount} by SMS` : ""}`;
  const when = e.reminderDaysBefore === 1 ? "the day before" : `${e.reminderDaysBefore} days before`;
  return `Reminder ${when}${e.reminder === "sms" ? ", with SMS" : ""}`;
}

type Item = { kind: "event"; e: EventRow } | { kind: "calendar"; c: CalendarEntry };

/** The school's events (coming, or past) by month, with term dates and holidays among them. */
export async function EventsView({ ctx, past }: { ctx: TenantContext; past: boolean }) {
  const slug = ctx.tenant.slug;
  const canManage = allowed(ctx, "events.manage");
  const canAsk = allowed(ctx, "consent.manage");
  const [list, audiences] = await Promise.all([
    listEvents(db(), ctx, { past }),
    canManage ? listAudiences(db(), ctx) : [],
  ]);
  const choices2: AudienceChoice[] = audiences.map((a) => ({
    value: `${a.audience}:${a.id ?? ""}`,
    label: a.label,
    families: a.families,
    withPush: a.withPush,
  }));
  const paused = ctx.billing.state === "limited";
  const newEvent = canManage && !past && (
    <NewEventDialog action={createEventAction.bind(null, slug)} audiences={choices2} smsPaused={paused} />
  );

  const items: Item[] = [
    ...list.events.map((e) => ({ kind: "event" as const, e })),
    ...list.calendar.map((c) => ({ kind: "calendar" as const, c })),
  ].sort((a, b) => {
    const da = a.kind === "event" ? a.e.startsOn : a.c.startsOn;
    const db_ = b.kind === "event" ? b.e.startsOn : b.c.startsOn;
    return past ? db_.localeCompare(da) : da.localeCompare(db_);
  });
  const months = new Map<string, { label: string; items: Item[] }>();
  for (const item of items) {
    const m = monthOf(item.kind === "event" ? item.e.startsOn : item.c.startsOn);
    const group = months.get(m.key) ?? { label: m.label, items: [] };
    group.items.push(item);
    months.set(m.key, group);
  }

  return (
    <div className="space-y-8">
      {newEvent && list.events.length > 0 && <div className="flex justify-end">{newEvent}</div>}
      {list.events.length === 0 ? (
        <EmptyState
          icon={<CalendarDays />}
          title={past ? "No past events" : "No events coming up"}
          description={
            past
              ? "Events from the last four months appear here once they are over."
              : "Add sports days, PTA meetings, trips and open days. Families see them in the parent view, and can be reminded the day before."
          }
          action={newEvent || undefined}
        />
      ) : null}
      {[...months.entries()].map(([key, month]) => (
        <section key={key} aria-labelledby={`month-${key}`} className="space-y-2">
          <h2 id={`month-${key}`} className="text-sm font-semibold tracking-wide text-ink-3 uppercase">
            {month.label}
          </h2>
          <ul className="divide-y divide-line border-y border-line">
            {month.items.map((item) =>
              item.kind === "calendar" ? (
                <li
                  key={`${item.c.kind}-${item.c.startsOn}-${item.c.name}`}
                  className="flex gap-4 py-3 text-sm text-ink-3"
                >
                  <span className="w-40 shrink-0">
                    {formatEventWhen({
                      startsOn: item.c.startsOn,
                      endsOn: item.c.endsOn,
                      startTime: null,
                      endTime: null,
                    })}
                  </span>
                  <span>{item.c.name}</span>
                </li>
              ) : (
                <li
                  key={item.e.id}
                  className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3
                        className={`text-md font-semibold ${item.e.cancelled ? "text-ink-3 line-through" : "text-ink"}`}
                      >
                        {item.e.title}
                      </h3>
                      {item.e.cancelled && <Badge tone="critical">Cancelled</Badge>}
                    </div>
                    <p className="text-base text-ink-2">
                      {formatEventWhen(item.e)}
                      {item.e.location ? ` · ${item.e.location}` : ""}
                    </p>
                    {item.e.details && (
                      <p className="text-sm whitespace-pre-line text-ink-2">{item.e.details}</p>
                    )}
                    <p className="text-sm text-ink-3">
                      {[
                        item.e.audienceLabel,
                        reminderText(item.e),
                        item.e.remindedAt ? formatDateTime(item.e.remindedAt, ctx.tenant.timezone) : null,
                        `added by ${item.e.by}`,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {item.e.forms > 0 && allowed(ctx, "consent.view") && (
                      <Link
                        href={schoolPath(slug, "events/forms") as Route}
                        className="inline-flex text-sm font-medium text-accent hover:underline"
                      >
                        {item.e.forms} consent {item.e.forms === 1 ? "form" : "forms"}
                      </Link>
                    )}
                  </div>
                  {!item.e.cancelled && !past && (canManage || canAsk) && (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {canAsk && (
                        <Link
                          href={`${schoolPath(slug, "events/forms")}?event=${item.e.id}` as Route}
                          className={buttonStyles("secondary", "sm")}
                        >
                          Ask for consent
                        </Link>
                      )}
                      {canManage && (
                        <>
                          <EditEventDialog
                            action={updateEventAction.bind(null, slug, item.e.id)}
                            audiences={choices2}
                            smsPaused={paused}
                            values={{
                              title: item.e.title,
                              details: item.e.details,
                              location: item.e.location,
                              startsOn: item.e.startsOn,
                              endsOn: item.e.endsOn,
                              startTime: item.e.startTime,
                              endTime: item.e.endTime,
                              audience: `${item.e.audience}:${item.e.audienceId ?? ""}`,
                              reminder: item.e.reminder,
                              reminderDaysBefore: item.e.reminderDaysBefore,
                            }}
                          />
                          <CancelEventDialog
                            action={cancelEventAction.bind(null, slug, item.e.id)}
                            title={item.e.title}
                            forms={item.e.forms}
                          />
                        </>
                      )}
                    </div>
                  )}
                </li>
              ),
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}
