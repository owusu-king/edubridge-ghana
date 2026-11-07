import type { Metadata } from "next";
import { Wordmark } from "@/components/ui/wordmark";
import { verifyRecordAction } from "./actions";
import { VerifyForm } from "./verify-form";

export const metadata: Metadata = { title: "Check a learner record" };

/** Public: anyone given a learner record (a school, a family) can check it was issued and not changed. */
export default function VerifyPage() {
  return (
    <div className="flex min-h-dvh flex-col px-5 py-6 sm:px-8">
      <header>
        <Wordmark />
      </header>
      <main id="main" className="mx-auto w-full max-w-xl flex-1 space-y-6 py-10">
        <div>
          <h1 className="font-display text-2xl font-medium tracking-tight">Check a learner record</h1>
          <p className="mt-2 text-base text-ink-2">
            Schools on EduBridge give families and other schools a signed record of a child&apos;s classes,
            report cards and attendance. Check one here: it shows who issued it and whether it has been
            changed or withdrawn. The file is checked, not kept.
          </p>
        </div>
        <VerifyForm action={verifyRecordAction} />
      </main>
    </div>
  );
}
