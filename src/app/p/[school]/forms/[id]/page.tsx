import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ConsentAnswer } from "@/components/parents/consent-answer";
import { db } from "@/server/db/client";
import { getParentConsentForm } from "@/server/events/consent";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { requireParent } from "@/web/parent-auth";
import { answerFormAction } from "../../../form-actions";

export const metadata: Metadata = { title: "Consent form" };

/** A consent form from the school, answered yes or no for each child (CNS-01). */
export default async function ParentConsentFormPage({
  params,
}: {
  params: Promise<{ school: string; id: string }>;
}) {
  const { school: slug, id } = await params;
  const { phone } = await requireParent();
  const form = await getParentConsentForm(db(), phone, slug, id);
  if (!form) notFound();

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
        <p className="mt-2 text-sm text-ink-3">{form.schoolName}</p>
        <h1 className="font-display text-2xl font-medium tracking-tight">{form.title}</h1>
        <p className="mt-1 text-sm text-ink-3">
          {form.cancelled
            ? "The school cancelled this form."
            : form.open
              ? `Please answer by the end of ${formatCalendarDate(form.deadline)}.`
              : `Answers closed on ${formatCalendarDate(form.deadline)}. Contact the school to change an answer.`}
        </p>
      </div>

      {form.event && (
        <p className="rounded-lg border border-line bg-surface px-5 py-4 text-base text-ink-2">
          For <span className="font-medium text-ink">{form.event.title}</span>: {form.event.when}
          {form.event.location ? `, ${form.event.location}` : ""}
        </p>
      )}

      <p className="text-base whitespace-pre-line text-ink">{form.body}</p>

      <ul aria-label="Your answers" className="divide-y divide-line border-y border-line">
        {form.children.map((c) => (
          <li key={c.studentId} className="space-y-3 py-5">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-md font-semibold text-ink">{c.name}</h2>
              {c.answer ? (
                <Badge tone={c.answer.answer === "yes" ? "positive" : "critical"}>
                  {c.answer.answer === "yes" ? "Yes" : "No"}
                </Badge>
              ) : (
                <Badge tone="caution">Waiting for an answer</Badge>
              )}
            </div>
            {c.answer && (
              <p className="text-sm text-ink-3">
                {c.answer.onPaper
                  ? "Recorded by the school from a paper slip"
                  : c.answer.byYou
                    ? "Answered by you"
                    : "Answered by another guardian"}{" "}
                on {formatDateTime(c.answer.at, form.timezone)}
                {c.answer.note ? `. Note: ${c.answer.note}` : ""}
              </p>
            )}
            {form.open && (
              <ConsentAnswer
                action={answerFormAction.bind(null, form.slug, form.id, c.studentId)}
                child={c.name}
                current={c.answer?.answer ?? null}
                note={c.answer?.byYou ? c.answer.note : null}
              />
            )}
          </li>
        ))}
      </ul>

      <p className="text-sm text-ink-3">
        Your answer is sent to {form.schoolName} with the time and the number you signed in with,{" "}
        {formatPhone(phone)}. Any guardian of the child can answer; the latest answer counts until the
        deadline.
      </p>
    </div>
  );
}
