import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { db } from "@/server/db/client";
import { listSchoolConsentForms } from "@/server/events/consent";
import { getParentEvents } from "@/server/events/events";
import { formatCalendarDate } from "@/lib/format";
import { formatEventWhen, monthOf } from "@/lib/events";
import { requireParent } from "@/web/parent-auth";

export const metadata: Metadata = { title: "Events" };

/** A school's coming events for this family's children (EVT-01), its term dates and holidays, and open forms. */
export default async function ParentEventsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school: slug } = await params;
  const { phone } = await requireParent();
  const [page, forms] = await Promise.all([
    getParentEvents(db(), phone, slug),
    listSchoolConsentForms(db(), phone, slug),
  ]);
  if (!page) notFound();
  type Item =
    | { kind: "event"; e: (typeof page.events)[number] }
    | { kind: "calendar"; c: (typeof page.calendar)[number] };
  const items: Item[] = [
    ...page.events.map((e) => ({ kind: "event" as const, e })),
    ...page.calendar.map((c) => ({ kind: "calendar" as const, c })),
  ].sort((a, b) =>
    (a.kind === "event" ? a.e.startsOn : a.c.startsOn).localeCompare(
      b.kind === "event" ? b.e.startsOn : b.c.startsOn,
    ),
  );
  const months = new Map<string, { label: string; items: Item[] }>();
  for (const item of items) {
    const m = monthOf(item.kind === "event" ? item.e.startsOn : item.c.startsOn);
    const group = months.get(m.key) ?? { label: m.label, items: [] };
    group.items.push(item);
    months.set(m.key, group);
  }

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={"/p" as Route}
          className="-ml-2 inline-flex h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Your children
        </Link>
        <h1 className="mt-2 font-display text-2xl font-medium tracking-tight">Events at {page.name}</h1>
      </div>

      {forms.length > 0 && (
        <section aria-labelledby="forms" className="space-y-2">
          <h2 id="forms" className="text-md font-semibold text-ink">
            Consent forms
          </h2>
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {forms.map((f) => {
              const waiting = f.children.filter((c) => !c.answer).length;
              return (
                <li key={f.id}>
                  <Link
                    href={`/p/${slug}/forms/${f.id}` as Route}
                    className="flex items-center gap-3 px-4 py-4 hover:bg-subtle focus-visible:bg-subtle"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-medium text-ink">{f.title}</p>
                      <p className="text-sm text-ink-3">By the end of {formatCalendarDate(f.deadline)}</p>
                    </div>
                    {waiting > 0 ? (
                      <Badge tone="caution">Answer needed</Badge>
                    ) : (
                      <Badge tone="positive">Answered</Badge>
                    )}
                    <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {items.length === 0 ? (
        <p className="text-base text-ink-2">Nothing on the school calendar for your children yet.</p>
      ) : (
        [...months.entries()].map(([key, month]) => (
          <section key={key} aria-labelledby={`month-${key}`} className="space-y-2">
            <h2 id={`month-${key}`} className="text-sm font-semibold tracking-wide text-ink-3 uppercase">
              {month.label}
            </h2>
            <ul className="divide-y divide-line border-y border-line">
              {month.items.map((item) =>
                item.kind === "calendar" ? (
                  <li
                    key={`${item.c.kind}-${item.c.startsOn}-${item.c.name}`}
                    className="py-3 text-sm text-ink-3"
                  >
                    {formatEventWhen({
                      startsOn: item.c.startsOn,
                      endsOn: item.c.endsOn,
                      startTime: null,
                      endTime: null,
                    })}
                    {" · "}
                    {item.c.name}
                  </li>
                ) : (
                  <li key={item.e.id} className="space-y-1 py-4">
                    <div className="flex items-start justify-between gap-3">
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
                    {item.e.for.length > 0 && (
                      <p className="text-sm text-ink-3">For {item.e.for.join(" and ")}</p>
                    )}
                    {item.e.details && (
                      <p className="text-base whitespace-pre-line text-ink-2">{item.e.details}</p>
                    )}
                  </li>
                ),
              )}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
