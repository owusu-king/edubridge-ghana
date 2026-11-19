import type { Metadata } from "next";
import { StatusText } from "@/components/ui/badge";
import { DescriptionList, PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { db } from "@/server/db/client";
import { getAiAdmin } from "@/server/ai/admin";
import { getIntegrations } from "@/server/platform/integrations";
import { AI_PROVIDERS } from "@/lib/ai-providers";
import { formatDateTime } from "@/lib/format";
import { requirePlatformAdmin } from "@/web/auth";
import {
  removeAiKeyAction,
  rotateSigningKeyAction,
  saveAiKeyAction,
  saveAiLimitsAction,
  saveAiSettingsAction,
} from "./actions";
import {
  AiLimitsForm,
  AiSettingsForm,
  ApiKeyForm,
  RemoveKeyDialog,
  RotateKeyDialog,
} from "./integration-forms";

export const metadata: Metadata = { title: "Integrations" };

const when = (d: Date) => formatDateTime(d, "Africa/Accra");

/** Platform-managed integrations: the AI gateway, record signing keys and Paystack's status. */
export default async function IntegrationsPage() {
  const user = await requirePlatformAdmin();
  const [view, ai] = await Promise.all([getIntegrations(db(), user.id), getAiAdmin(db(), user.id)]);
  const { paystack } = view;
  const info = AI_PROVIDERS[ai.config.provider];
  return (
    <div className="space-y-12">
      <PageHeader
        title="Integrations"
        description="Services EduBridge uses on behalf of schools. Secrets are stored encrypted and never shown after saving. Every change is recorded below."
      />

      <Section
        title="AI"
        description="Every AI feature goes through one gateway. Free and local providers cost nothing and are sent de-identified data only; a paid provider needs the founder's approval and the data-protection review first (D-R5-6, D-R5-7)."
      >
        <DescriptionList
          items={[
            {
              term: "Status",
              detail: (
                <StatusText tone={ai.config.enabled && ai.config.configured ? "positive" : "neutral"}>
                  {!ai.config.enabled
                    ? "Off for the platform"
                    : ai.config.configured
                      ? "On"
                      : "On, but the provider is not set up"}
                </StatusText>
              ),
            },
            {
              term: "Provider",
              detail: `${info.label}${ai.config.provider === "none" ? "" : ` · ${ai.config.model || "no model chosen"}`}`,
            },
            {
              term: "Data sent",
              detail: ai.config.identifiableApproved
                ? "Approved for identifiable data; each school's choice about names applies"
                : "De-identified only: no names, admission numbers, contact details or school name",
            },
            {
              term: "API key",
              detail: !info.needsKey
                ? "Not needed"
                : ai.key.source === "platform"
                  ? `Saved, ending …${ai.key.hint}${ai.key.updatedBy ? `, by ${ai.key.updatedBy}` : ""}${ai.key.updatedAt ? ` on ${when(ai.key.updatedAt)}` : ""}`
                  : ai.key.source === "environment"
                    ? "Taken from the server's environment"
                    : "Not set",
            },
            {
              term: "This month",
              detail: `${ai.usage.platformTokens.toLocaleString("en-GH")} of ${ai.config.limits.platformMonthlyTokens.toLocaleString("en-GH")} tokens, every school together`,
            },
          ]}
        />
        <AiSettingsForm
          action={saveAiSettingsAction}
          config={{
            enabled: ai.config.enabled,
            provider: ai.config.provider,
            model: ai.config.model,
            baseUrl: ai.config.baseUrl,
            identifiableApproved: ai.config.identifiableApproved,
            tasks: ai.config.tasks,
          }}
        />
        {info.needsKey && (
          <div className="space-y-3">
            <ApiKeyForm
              action={saveAiKeyAction.bind(null, ai.config.provider)}
              hasKey={ai.key.source === "platform"}
              provider={info.label}
            />
            {ai.key.source === "platform" && (
              <RemoveKeyDialog
                action={removeAiKeyAction.bind(null, ai.config.provider)}
                provider={info.label}
              />
            )}
          </div>
        )}
      </Section>

      <Section
        title="AI limits"
        description="Checked before every AI call. A school can be given its own monthly allowance on its page under Schools. When a limit is reached, people are told plainly when it starts again."
      >
        <AiLimitsForm action={saveAiLimitsAction} limits={ai.config.limits} />
        {ai.usage.bySchool.length > 0 && (
          <TableFrame>
            <Table>
              <caption className="sr-only">AI use this month by school</caption>
              <THead>
                <tr>
                  <TH>School</TH>
                  <TH className="text-right">Tokens</TH>
                  <TH className="text-right">Requests</TH>
                  <TH className="text-right">Stopped by a limit</TH>
                </tr>
              </THead>
              <TBody>
                {ai.usage.bySchool.map((s) => (
                  <TR key={s.tenantId}>
                    <TD className="font-medium text-ink">{s.name}</TD>
                    <TD className="text-right tabular-nums">{s.tokens.toLocaleString("en-GH")}</TD>
                    <TD className="text-right tabular-nums">{s.requests}</TD>
                    <TD className="text-right tabular-nums">{s.blocked}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>

      <Section
        title="Learner record signing"
        description="Keys that sign official learner records (Transfer Passport). One key signs new records; retired keys keep verifying the records they signed. Public keys are published at /api/v1/passport/keys."
      >
        {!view.signingReady && (
          <p className="max-w-2xl text-sm text-ink-2">
            No production key yet. Outside production a development key is used; production refuses to issue
            records until a key is created here.
          </p>
        )}
        {view.signingKeys.length > 0 && (
          <TableFrame>
            <Table>
              <THead>
                <tr>
                  <TH>Key</TH>
                  <TH>Status</TH>
                  <TH>Created</TH>
                  <TH>Retired</TH>
                </tr>
              </THead>
              <TBody>
                {view.signingKeys.map((k) => (
                  <TR key={k.keyId}>
                    <TD className="font-mono text-sm text-ink">{k.keyId}</TD>
                    <TD>
                      <StatusText tone={k.status === "active" ? "positive" : "neutral"}>
                        {k.status === "active" ? "Signs new records" : "Retired (verifies only)"}
                      </StatusText>
                    </TD>
                    <TD className="whitespace-nowrap">
                      {when(k.createdAt)}
                      {k.createdBy ? ` · ${k.createdBy}` : ""}
                    </TD>
                    <TD className="whitespace-nowrap">{k.retiredAt ? when(k.retiredAt) : "—"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
        <RotateKeyDialog action={rotateSigningKeyAction} first={view.signingKeys.length === 0} />
      </Section>

      <Section
        title="Paystack (Mobile Money)"
        description="Keys come from the server's environment. Live payments stay off until PAYSTACK_ALLOW_LIVE=true is set with the founder's approval."
      >
        <ul className="space-y-1 text-sm text-ink-2">
          <li>Test key: {paystack.testKeySet ? "set" : "not set"}</li>
          <li>Live key: {paystack.liveKeySet ? "set" : "not set"}</li>
          <li>Live payments: {paystack.liveAllowed ? "allowed" : "not allowed"}</li>
        </ul>
      </Section>

      <Section title="Changes" description="The last 30 changes to integrations.">
        {view.events.length === 0 ? (
          <p className="text-sm text-ink-3">None yet.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line text-sm">
            {view.events.map((e, i) => (
              <li key={i} className="flex justify-between gap-3 py-2">
                <span className="text-ink">
                  {e.action.replace(/[._]/g, " ")}
                  {typeof e.metadata.keyId === "string" ? ` (${e.metadata.keyId})` : ""}
                </span>
                <span className="text-ink-3">
                  {e.by ?? "System"} · {when(e.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
