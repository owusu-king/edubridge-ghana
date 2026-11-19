import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Megaphone } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { getSchoolBilling } from "@/server/billing/subscriptions";
import { db } from "@/server/db/client";
import {
  listAnnouncements,
  listAudiences,
  listScheduledAnnouncements,
} from "@/server/messages/announcements";
import { ActionButton } from "@/components/ui/action-forms";
import { Section } from "@/components/ui/layout";
import { formatDateTime } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { cancelScheduledAction, postAnnouncementAction } from "./actions";
import { NewAnnouncementDialog } from "./announcement-dialog";
import { draftAnnouncementAction } from "../drafting-actions";
import { draftingAvailability } from "@/server/drafting/service";

export const metadata: Metadata = { title: "Announcements" };

export default async function AnnouncementsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "communication.send")) notFound();
  const [list, scheduled, audiences, billing, drafting] = await Promise.all([
    listAnnouncements(db(), ctx),
    listScheduledAnnouncements(db(), ctx),
    listAudiences(db(), ctx),
    allowed(ctx, "plan.view") ? getSchoolBilling(db(), ctx) : null,
    draftingAvailability(db(), ctx, "announcements"),
  ]);
  const dialog = (
    <NewAnnouncementDialog
      currency={ctx.tenant.currencyCode}
      schoolName={ctx.tenant.name}
      smsLink={`${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/p`}
      action={postAnnouncementAction.bind(null, ctx.tenant.slug)}
      audiences={audiences.map((a) => ({
        value: `${a.audience}:${a.id ?? ""}`,
        label: a.label,
        families: a.families,
        withPush: a.withPush,
      }))}
      smsPricePesewas={billing?.plan.smsPricePesewas ?? null}
      smsPaused={ctx.billing.state === "limited"}
      drafting={drafting ? { ...drafting, draft: draftAnnouncementAction.bind(null, ctx.tenant.slug) } : null}
    />
  );

  return (
    <div className="space-y-8">
      <PageHeader
        title="Announcements"
        description="News for families: the whole school, a campus, a level or a class. Families read them in the parent view."
        actions={(list.length > 0 || scheduled.length > 0) && dialog}
      />
      {scheduled.length > 0 && (
        <Section
          title="Scheduled"
          description="Posted by EduBridge at the time shown, with their notifications and SMS."
        >
          <ul aria-label="Scheduled announcements" className="divide-y divide-line border-y border-line">
            {scheduled.map((a) => (
              <li
                key={a.id}
                className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="text-base font-medium text-ink">{a.title}</p>
                  <p className="text-sm text-ink-3">
                    {formatDateTime(a.sendAt, ctx.tenant.timezone)} · {a.audienceLabel}
                    {a.sms ? " · with SMS" : ""} · by {a.by}
                  </p>
                </div>
                <ActionButton
                  action={cancelScheduledAction.bind(null, ctx.tenant.slug, a.id)}
                  label="Cancel"
                  ariaLabel={`Cancel the scheduled announcement ${a.title}`}
                />
              </li>
            ))}
          </ul>
        </Section>
      )}
      {list.length === 0 ? (
        <EmptyState
          icon={<Megaphone />}
          title="No announcements yet"
          description="Tell families about events, closures or reminders. They appear in the parent view, and can be sent by SMS too."
          action={scheduled.length ? undefined : dialog}
        />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {list.map((a) => (
            <li key={a.id} className="space-y-2 py-5">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
                <h2 className="text-md font-semibold text-ink">{a.title}</h2>
                <p className="text-sm text-ink-3">{formatDateTime(a.createdAt, ctx.tenant.timezone)}</p>
              </div>
              <p className="text-base whitespace-pre-line text-ink-2">{a.body}</p>
              <p className="text-sm text-ink-3">
                {a.audienceLabel} · by {a.by} · read by {a.reads} {a.reads === 1 ? "family" : "families"}
                {a.pushCount ? ` · notified ${a.pushCount} on their phones` : ""}
                {a.smsCount ? ` · sent by SMS to ${a.smsCount}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
