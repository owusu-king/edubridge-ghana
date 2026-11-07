import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader, Section } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { assistantConfigured } from "@/server/assistant/model";
import { listAssistantQueries } from "@/server/assistant/service";
import { db } from "@/server/db/client";
import { formatDateTime } from "@/lib/format";
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
  const configured = assistantConfigured();

  return (
    <div className="space-y-10">
      <PageHeader
        title="Assistant"
        description="Ask about the school in plain words. Answers come only from the school's records that you can see yourself: published report cards, registers, fees and receipts. It reads; it never changes anything. Every question is recorded."
      />
      {configured ? (
        <AskForm action={askAssistantAction.bind(null, ctx.tenant.slug)} />
      ) : (
        <p className="max-w-2xl text-base text-ink-2">
          The assistant is not switched on for EduBridge yet. Insights shows the same figures.
        </p>
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
