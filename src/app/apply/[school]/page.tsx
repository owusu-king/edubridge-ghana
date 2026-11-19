import type { Metadata } from "next";
import { getOnlineApplicationForm } from "@/server/admissions/online";
import { db } from "@/server/db/client";
import { Wordmark } from "@/components/ui/wordmark";
import { confirmApplicationAction, startApplicationAction } from "./actions";
import { ApplyForm } from "./apply-form";

export const metadata: Metadata = { title: "Apply", robots: { index: false } };

/** A school's online application form (ADM-02). Public; open only while the school takes applications online. */
export default async function ApplyPage({ params }: { params: Promise<{ school: string }> }) {
  const { school: slug } = await params;
  const form = await getOnlineApplicationForm(db(), slug);
  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:py-12">
      <div className="mb-8 text-ink-3">
        <Wordmark />
      </div>
      {!form ? (
        <div className="space-y-2">
          <h1 className="font-display text-2xl font-medium tracking-tight text-ink">Applications</h1>
          <p className="text-base text-ink-2">
            This school is not taking applications online. Please contact the school directly.
          </p>
        </div>
      ) : (
        <>
          <h1 className="font-display text-2xl font-medium tracking-tight text-ink">
            Apply to {form.school.name}
          </h1>
          <p className="mt-2 mb-8 text-base text-ink-2">
            A few details about your child and how to reach you. The school will contact you about the next
            steps.
          </p>
          <ApplyForm
            schoolName={form.school.name}
            levels={form.levels}
            terms={form.terms}
            start={startApplicationAction.bind(null, form.school.slug)}
            confirm={confirmApplicationAction.bind(null, form.school.slug)}
          />
        </>
      )}
    </div>
  );
}
