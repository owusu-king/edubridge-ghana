import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getSetupProgress } from "@/server/setup/progress";
import { cn } from "@/lib/cn";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { STEP_INFO, stepHref, whoCan } from "@/web/setup-steps";

export const metadata: Metadata = { title: "Setup guide" };

export default async function SetupGuidePage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const progress = await getSetupProgress(db(), ctx);
  if (!progress) notFound();
  const slug = ctx.tenant.slug;
  const next = progress.applicable.find((s) => progress.steps[s].status !== "done");

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Command Center"
        title="Setup guide"
        description="Steps to get your school running on EduBridge, in the order that works best. Each step ticks itself off once your records show it is done."
      />

      <div className="space-y-2">
        <p className="text-base text-ink">
          <span className="font-semibold">
            {progress.done} of {progress.applicable.length} steps done
          </span>
          {progress.complete ? ". Your school is set up." : ""}
        </p>
        <div
          role="img"
          aria-label={`${progress.done} of ${progress.applicable.length} steps done`}
          className="flex max-w-md gap-0.5"
        >
          {progress.applicable.map((s) => (
            <span
              key={s}
              className={cn(
                "h-2 flex-1 first:rounded-l-full last:rounded-r-full",
                progress.steps[s].status === "done" ? "bg-positive" : "bg-subtle",
              )}
            />
          ))}
        </div>
      </div>

      <ol className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
        {progress.applicable.map((step, i) => {
          const info = STEP_INFO[step];
          const state = progress.steps[step];
          const done = state.status === "done";
          const isNext = step === next;
          const permitted = allowed(ctx, info.permission);
          return (
            <li
              key={step}
              aria-current={isNext ? "step" : undefined}
              className={cn(
                "relative grid grid-cols-[2rem_minmax(0,1fr)] gap-x-4 gap-y-3 px-4 py-5 sm:grid-cols-[2rem_minmax(0,1fr)_auto] sm:gap-x-5 sm:px-6",
                isNext && "bg-subtle/60",
              )}
            >
              {isNext && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-accent" />}
              <span
                aria-hidden="true"
                className={cn(
                  "flex size-8 items-center justify-center rounded-full text-sm font-semibold tabular-nums ring-1 ring-inset",
                  done
                    ? "bg-positive-soft text-positive ring-positive/30"
                    : isNext
                      ? "bg-surface text-accent ring-accent"
                      : "bg-surface text-ink-3 ring-line-strong",
                )}
              >
                {done ? <Check className="size-4" /> : i + 1}
              </span>
              <div className="min-w-0 space-y-1 pt-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <h2 className="text-md font-semibold text-ink">
                    {info.title}
                    <span className="sr-only">
                      {done ? " (done)" : state.status === "started" ? " (started)" : " (to do)"}
                    </span>
                  </h2>
                  {isNext && <Badge tone="accent">Next</Badge>}
                </div>
                <p className="text-base text-ink-2">{info.why}</p>
                <p className="flex items-start gap-1.5 text-sm text-ink-3">
                  {done && <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-positive" />}
                  <span>{state.detail}</span>
                </p>
                {step === "teachers" && allowed(ctx, "academics.manage") && (
                  <p className="text-sm">
                    <Link href={schoolPath(slug, "classes")} className="text-accent hover:underline">
                      Choose class teachers under Classes
                    </Link>
                  </p>
                )}
              </div>
              <div className="col-start-2 sm:col-start-auto sm:justify-self-end">
                {permitted ? (
                  <Link
                    href={stepHref(slug, step) as Route}
                    className={buttonStyles(isNext ? "primary" : "secondary")}
                  >
                    {info.action}
                  </Link>
                ) : (
                  <p className="max-w-48 text-sm text-ink-3">The {whoCan(info.permission)} does this.</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
