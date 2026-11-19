import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader, Section } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { aiAvailability } from "@/server/ai/gateway";
import { assistantStatus, listAssistantQueries } from "@/server/assistant/service";
import { db } from "@/server/db/client";
import { formatDateTime } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { askAssistantAction } from "./actions";
import { AskForm } from "./ask-form";

export const metadata: Metadata = { title: "Assistant" };

/**
 * The school assistant (AI): questions answered from the school's own records, within what the person may
 * see, with every question recorded. Leaders see everyone's questions (as with the audit log).
 */
export default async function AssistantPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "assistant.use")) notFound();
  const everyone = allowed(ctx, "audit.view");
  const history = await listAssistantQueries(db(), ctx, { everyone });
  const status = await assistantStatus(db(), ctx);
  const availability = status.platform && status.school ? await aiAvailability(db(), ctx, "assistant") : null;

  return (
    <div className="space-y-10">
      <PageHeader
        title="Assistant"
        description="Ask about the school in plain words. Answers come only from the school's records that you can see yourself: published report cards, registers, fees and receipts. It reads; it never changes anything. Every question is recorded."
      />
      {!status.platform ? (
        <p className="max-w-2xl text-base text-ink-2">
          The assistant is not switched on for EduBridge yet. Insights shows the same figures.
        </p>
      ) : !status.school ? (
        <p className="max-w-2xl text-base text-ink-2">
          The Proprietor has not turned the assistant on for this school
          {allowed(ctx, "assistant.manage") ? " (Settings, Assistant)" : ""}. Insights shows the same figures.
        </p>
      ) : availability && !availability.available ? (
        <p className="max-w-2xl text-base text-ink-2">
          {availability.message} Insights shows the same figures.
        </p>
      ) : (
        <div className="space-y-3">
          {(status.deidentified || !status.shareNames) && (
            <p className="max-w-2xl text-sm text-ink-3">
              Names are not sent to the assistant&apos;s provider: it sees references, and names are put back
              here on screen.
            </p>
          )}
          <AskForm
            action={askAssistantAction.bind(null, ctx.tenant.slug)}
            schoolPath={schoolPath(ctx.tenant.slug)}
          />
        </div>
      )}
      <Section
        title={everyone ? "Recent questions at this school" : "Your recent questions"}
        description={everyone ? "Everyone's questions, with the records each one read." : undefined}
      >
        {history.length === 0 ? (
          <p className="text-sm text-ink-3">No questions yet.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {history.map((q) => (
              <li key={q.id} className="space-y-1 py-4">
                <p className="text-base font-medium text-ink">{q.question}</p>
                <p className="text-sm text-ink-3">
                  {formatDateTime(q.createdAt, ctx.tenant.timezone)}
                  {everyone ? ` · ${q.askedBy}${q.bySupport ? " (EduBridge support)" : ""}` : ""} · read:{" "}
                  {q.tools.length ? q.tools.map((t) => t.name.replace(/_/g, " ")).join(", ") : "nothing"}
                  {q.status !== "answered" ? ` · ${q.status}` : ""}
                  {q.uncheckedFigures.length > 0
                    ? ` · figures not checked: ${q.uncheckedFigures.join(", ")}`
                    : ""}
                </p>
                {q.answer && (
                  <details className="text-sm text-ink-2">
                    <summary className="cursor-pointer text-accent">Answer</summary>
                    <p className="mt-1 whitespace-pre-line">{q.answer}</p>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
