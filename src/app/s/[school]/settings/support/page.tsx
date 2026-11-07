import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getSupportAccess, SUPPORT_DURATIONS, type SupportGrantRow } from "@/server/support/access";
import { auditLabel } from "@/lib/audit-labels";
import { formatDateTime } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { endSupportAccessAction, grantSupportAccessAction } from "./actions";
import { EndSupportForm, GrantSupportForm } from "./support-forms";

export const metadata: Metadata = { title: "Settings · Support access" };

const describe = (a: { kind: "view" | "action" | "change"; what: string }) =>
  a.kind === "change" ? auditLabel(a.what) : `${a.kind === "view" ? "Opened" : "Sent a form on"} ${a.what}`;

/**
 * Support access (PLT-02): the Proprietor decides whether, and for how long, EduBridge support can open
 * the school, and sees everything support opened and changed.
 */
export default async function SupportAccessPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "support.manage")) notFound();
  const { live, grants, activity } = await getSupportAccess(db(), ctx);
  const when = (d: Date) => formatDateTime(d, ctx.tenant.timezone);
  const state = (g: SupportGrantRow) =>
    g.live
      ? `Until ${when(g.expiresAt)}`
      : g.endedAt
        ? `Ended ${when(g.endedAt)}${g.endedBy ? ` by ${g.endedBy}` : ""}`
        : `Ended ${when(g.expiresAt)}`;

  return (
    <div className="space-y-12">
      <Section
        title="Support access"
        description="Let EduBridge support open your school to help you, for as long as you choose. Support can see and change what you can, except this setting and data downloads. Everything support opens and changes is recorded here and in the audit log."
      >
        <div className="max-w-xl space-y-5">
          {live ? (
            <div className="space-y-4 rounded-lg border border-line bg-surface px-5 py-4">
              <StatusText tone="caution">
                EduBridge support can open the school until {when(live.expiresAt)}
              </StatusText>
              <p className="text-sm text-ink-3">
                Allowed by {live.grantedBy} on {when(live.createdAt)}
                {live.note ? `: “${live.note}”` : "."}
              </p>
              <EndSupportForm action={endSupportAccessAction.bind(null, ctx.tenant.slug)} />
            </div>
          ) : (
            <StatusText tone="neutral">EduBridge support cannot open the school.</StatusText>
          )}
          <GrantSupportForm
            action={grantSupportAccessAction.bind(null, ctx.tenant.slug)}
            durations={SUPPORT_DURATIONS}
            live={live !== null}
          />
        </div>
      </Section>

      {grants.length > 0 && (
        <Section title="Past and current access" description="The last 20 times support access was allowed.">
          <TableFrame>
            <Table>
              <THead>
                <tr>
                  <TH>Allowed</TH>
                  <TH>By</TH>
                  <TH>Access</TH>
                  <TH numeric>Pages opened</TH>
                  <TH numeric>Changes</TH>
                </tr>
              </THead>
              <TBody>
                {grants.map((g) => (
                  <TR key={g.id}>
                    <TD className="whitespace-nowrap">{when(g.createdAt)}</TD>
                    <TD className="text-ink">{g.grantedBy}</TD>
                    <TD>{state(g)}</TD>
                    <TD numeric>{g.pagesViewed}</TD>
                    <TD numeric>{g.changes}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        </Section>
      )}

      {grants.length > 0 && (
        <Section
          title="What support did"
          description="During the most recent access, newest first. Changes are also in the audit log, marked EduBridge support."
        >
          {activity.length === 0 ? (
            <p className="text-base text-ink-2">Support has not opened the school during this access.</p>
          ) : (
            <TableFrame>
              <Table>
                <THead>
                  <tr>
                    <TH>When</TH>
                    <TH>Who</TH>
                    <TH>What</TH>
                  </tr>
                </THead>
                <TBody>
                  {activity.map((a, i) => (
                    <TR key={i}>
                      <TD className="whitespace-nowrap">{when(a.at)}</TD>
                      <TD className="text-ink">{a.by}</TD>
                      <TD className="break-all">{describe(a)}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
        </Section>
      )}
    </div>
  );
}
