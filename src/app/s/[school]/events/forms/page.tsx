import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { FileCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { getSchoolBilling } from "@/server/billing/subscriptions";
import { db } from "@/server/db/client";
import { listConsentForms } from "@/server/events/consent";
import { listEventChoices } from "@/server/events/events";
import { listAudiences } from "@/server/messages/announcements";
import { formatCalendarDate } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { createConsentFormAction } from "../actions";
import { NewConsentFormDialog } from "../event-controls";

export const metadata: Metadata = { title: "Consent forms" };

/** Consent forms (CNS-01) with how many children have an answer. */
export default async function ConsentFormsPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ event?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "consent.view")) notFound();
  const slug = ctx.tenant.slug;
  const canManage = allowed(ctx, "consent.manage");
  const [forms, audiences, events, billing] = await Promise.all([
    listConsentForms(db(), ctx),
    canManage ? listAudiences(db(), ctx) : [],
    canManage ? listEventChoices(db(), ctx) : [],
    canManage && allowed(ctx, "plan.view") ? getSchoolBilling(db(), ctx) : null,
  ]);
  const dialog = canManage && (
    <NewConsentFormDialog
      action={createConsentFormAction.bind(null, slug)}
      audiences={audiences.map((a) => ({
        value: `${a.audience}:${a.id ?? ""}`,
        label: a.label,
        families: a.families,
        withPush: a.withPush,
      }))}
      events={events.map((e) => ({
        id: e.id,
        label: `${e.title}, ${formatCalendarDate(e.startsOn)}`,
        audience: `${e.audience}:${e.audienceId ?? ""}`,
      }))}
      schoolName={ctx.tenant.name}
      smsLink={`${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/p`}
      currency={ctx.tenant.currencyCode}
      smsPricePesewas={billing?.plan.smsPricePesewas ?? null}
      smsPaused={ctx.billing.state === "limited"}
      eventId={events.some((e) => e.id === search.event) ? search.event : undefined}
    />
  );
  if (forms.length === 0)
    return (
      <EmptyState
        icon={<FileCheck />}
        title="No consent forms yet"
        description={
          canManage
            ? "Ask families' permission for a trip, an activity or photos. They answer yes or no for each child in the parent view, and you see who has not answered."
            : "Forms the school sends to families appear here, with the answers for your classes."
        }
        action={dialog || undefined}
      />
    );
  return (
    <div className="space-y-6">
      {dialog && <div className="flex justify-end">{dialog}</div>}
      <TableFrame>
        <Table>
          <caption className="sr-only">Consent forms</caption>
          <THead>
            <tr>
              <TH>Form</TH>
              <TH>Deadline</TH>
              <TH numeric>Yes</TH>
              <TH numeric>No</TH>
              <TH numeric>Waiting</TH>
            </tr>
          </THead>
          <TBody>
            {forms.map((f) => (
              <TR key={f.id}>
                <TD>
                  <Link
                    href={schoolPath(slug, `events/forms/${f.id}`) as Route}
                    className="font-medium text-ink hover:underline"
                  >
                    {f.title}
                  </Link>
                  <span className="block text-sm text-ink-3">
                    {[f.audienceLabel, f.eventTitle].filter(Boolean).join(" · ")}
                  </span>
                </TD>
                <TD>
                  {formatCalendarDate(f.deadline)}{" "}
                  {f.cancelled ? (
                    <Badge tone="critical">Cancelled</Badge>
                  ) : !f.open ? (
                    <Badge>Closed</Badge>
                  ) : null}
                </TD>
                <TD numeric>{f.counts.yes}</TD>
                <TD numeric>{f.counts.no}</TD>
                <TD numeric>{f.counts.waiting}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </TableFrame>
    </div>
  );
}
