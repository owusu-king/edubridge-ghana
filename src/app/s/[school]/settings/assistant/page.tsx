import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Section } from "@/components/ui/layout";
import { getSchoolAiUsage } from "@/server/ai/gateway";
import { assistantStatus } from "@/server/assistant/service";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getSchoolPreferences } from "@/server/tenancy/preferences";
import { requireTenant } from "@/web/auth";
import { SwitchesForm } from "../preference-forms";
import { saveAssistantPreferencesAction } from "./actions";

export const metadata: Metadata = { title: "Settings · Assistant" };

/** The Proprietor's controls for the school assistant (AI), with what it sends and to whom. */
export default async function AssistantSettingsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "assistant.manage")) notFound();
  const [prefs, status, usage] = await Promise.all([
    getSchoolPreferences(db(), ctx),
    assistantStatus(db(), ctx),
    getSchoolAiUsage(db(), ctx),
  ]);
  return (
    <Section
      title="School assistant (AI)"
      description="Lets the Proprietor, Head teacher, Administrator and Accountant ask questions about the school in plain words. It reads the same records they can see, never changes anything, and every question is recorded."
    >
      <div className="max-w-2xl space-y-3 text-sm text-ink-2">
        <p>
          To answer, the assistant sends the question and the figures it needs (for example fee balances,
          attendance or results) to EduBridge&apos;s AI provider
          {status.platform ? ` (${status.provider})` : ""}. Nothing is sent until you turn it on.
        </p>
        {status.deidentified ? (
          <p>
            EduBridge&apos;s provider is not approved for identifiable data, so names, admission numbers,
            contact details and the school&apos;s name are never sent to it, whatever you choose below.
          </p>
        ) : (
          <p>
            The provider processes the figures on EduBridge&apos;s behalf, under terms reviewed for data
            protection.
          </p>
        )}
        <p>
          This month: {usage.tokens.toLocaleString("en-GH")} of {usage.allowance.toLocaleString("en-GH")}{" "}
          tokens used ({usage.requests} {usage.requests === 1 ? "question" : "questions"}
          {usage.blocked ? `, ${usage.blocked} stopped by a limit` : ""}).
        </p>
        {!status.platform && (
          <p className="text-ink-3">
            EduBridge has not switched the assistant on yet; your choice applies once it does.
          </p>
        )}
      </div>
      <SwitchesForm
        action={saveAssistantPreferencesAction.bind(null, ctx.tenant.slug)}
        switches={[
          {
            name: "assistantEnabled",
            label: "Let staff use the assistant",
            note: "For the roles above, within what each person can already see.",
            checked: prefs.assistantEnabled,
          },
          {
            name: "assistantShareNames",
            label: "Send names of students and staff to the provider",
            note: status.deidentified
              ? "Has no effect while EduBridge's provider is de-identified only. Questions you type are sent as written."
              : "Off (recommended): the provider sees references such as [P1] and names are put back on screen. Questions you type are sent as written.",
            checked: prefs.assistantShareNames,
          },
        ]}
      />
    </Section>
  );
}
