import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Megaphone } from "lucide-react";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { getSchoolBilling } from "@/server/billing/subscriptions";
import { db } from "@/server/db/client";
import { listAnnouncements, listAudiences } from "@/server/messages/announcements";
import { formatDateTime } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { postAnnouncementAction } from "./actions";
import { NewAnnouncementDialog } from "./announcement-dialog";

export const metadata: Metadata = { title: "Announcements" };

export default async function AnnouncementsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "communication.send")) notFound();
  const [list, audiences, billing] = await Promise.all([
    listAnnouncements(db(), ctx),
    listAudiences(db(), ctx),
    allowed(ctx, "plan.view") ? getSchoolBilling(db(), ctx) : null,
  ]);
  const dialog = (
    <NewAnnouncementDialog
      action={postAnnouncementAction.bind(null, ctx.tenant.slug)}
      audiences={audiences.map((a) => ({
        value: `${a.audience}:${a.id ?? ""}`,
        label: a.label,
        families: a.families,
      }))}
      smsPricePesewas={billing?.plan.smsPricePesewas ?? null}
      smsPaused={ctx.billing.state === "limited"}
    />
  );

  return (
    <div className="space-y-8">
      <PageHeader
        title="Announcements"
        description="News for families: the whole school, a campus, a level or a class. Families read them in the parent view."
        actions={list.length > 0 && dialog}
      />
      {list.length === 0 ? (
        <EmptyState
          icon={<Megaphone />}
          title="No announcements yet"
          description="Tell families about events, closures or reminders. They appear in the parent view, and can be sent by SMS too."
          action={dialog}
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
                {a.smsCount ? ` · sent by SMS to ${a.smsCount}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
