import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Check, FileSpreadsheet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getSetupProgress } from "@/server/setup/progress";
import { cn } from "@/lib/cn";
import { isSetupPath, OPTIONAL_STEPS, type SetupPath } from "@/lib/setup";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { stepHref, stepInfo, whoCan } from "@/web/setup-steps";

export const metadata: Metadata = { title: "Setup guide" };

const PATHS: { path: SetupPath; label: string }[] = [
  { path: "fresh", label: "Starting fresh" },
  { path: "switch", label: "Moving from another system" },
];

/** What to take out of the old system before starting (the import pages accept these columns). */
const BRING = [
  {
    title: "Your student list",
    body: "One row per student: admission number, first name, surname, sex, date of birth and class, with a guardian's name, phone number and relationship. Most systems can save this as Excel or CSV.",
    template: "/templates/students-import.csv",
  },
  {
    title: "What each family owes",
    body: "Each student's admission number and the balance they owed when you stopped using the old system, or what they had paid ahead.",
    template: "/templates/opening-balances.csv",
  },
  {
    title: "Your staff list",
    body: "One row per person, teaching and support staff: name, phone, email, position, department, employment type and start date. Only names are needed.",
    template: "/templates/staff-import.csv",
  },
];

/**
 * The setup guide: the steps to get a school running, ticked off from its records. A school moving from another
 * system follows the same steps in the order an import needs, with what to bring from the old system first
 * (2026-11-19).
 */
export default async function SetupGuidePage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ path?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  const path: SetupPath = isSetupPath(search.path) ? search.path : "fresh";
  const progress = await getSetupProgress(db(), ctx, path);
  if (!progress) notFound();
  const slug = ctx.tenant.slug;
  const optional = (s: (typeof progress.applicable)[number]) => OPTIONAL_STEPS.includes(s);
  const next = progress.applicable.find((s) => progress.steps[s].status !== "done" && !optional(s));
  const required = progress.applicable.filter((s) => !optional(s));

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Command Center"
        title="Setup guide"
        description={
          path === "switch"
            ? "Bring your school's records from the system you use now, in the order that makes the import work. Each step ticks itself off once your records show it is done."
            : "Steps to get your school running on EduBridge, in the order that works best. Each step ticks itself off once your records show it is done."
        }
      />

      <nav aria-label="Which guide" className="inline-flex rounded-lg border border-line bg-subtle/60 p-0.5">
        {PATHS.map((p) => (
          <Link
            key={p.path}
            href={`${schoolPath(slug, "setup")}${p.path === "switch" ? "?path=switch" : ""}` as Route}
            aria-current={p.path === path ? "page" : undefined}
            className={cn(
              "inline-flex h-8 items-center rounded-md px-3 text-base transition-colors",
              p.path === path ? "bg-surface font-medium text-ink shadow-raised" : "text-ink-2 hover:text-ink",
            )}
          >
            {p.label}
          </Link>
        ))}
      </nav>

      {path === "switch" && (
        <section
          aria-labelledby="bring-heading"
          className="rounded-lg border border-line bg-surface p-5 sm:p-6"
        >
          <h2 id="bring-heading" className="text-md font-semibold text-ink">
            Before you start: what to bring from your old system
          </h2>
          <p className="mt-1 max-w-2xl text-base text-ink-2">
            Export these lists from the system you use now. Keep the old system until the first term on
            EduBridge is billed and checked, in case a record needs looking up.
          </p>
          <ul className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {BRING.map((b) => (
              <li key={b.title} className="flex gap-3 rounded-md border border-line p-4">
                <FileSpreadsheet aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" />
                <div className="min-w-0">
                  <p className="text-base font-medium text-ink">{b.title}</p>
                  <p className="mt-1 text-sm text-ink-2">{b.body}</p>
                  <a
                    href={b.template}
                    download
                    className="mt-2 inline-block text-sm text-accent hover:underline"
                  >
                    Download the template
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="space-y-2">
        <p className="text-base text-ink">
          <span className="font-semibold">
            {progress.done} of {progress.required} steps done
          </span>
          {progress.complete ? ". Your school is set up." : ""}
        </p>
        <div
          role="img"
          aria-label={`${progress.done} of ${progress.required} steps done`}
          className="flex max-w-md gap-0.5"
        >
          {required.map((s) => (
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
          const info = stepInfo(step, path);
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
                  {optional(step) && !done && <Badge>If you need it</Badge>}
                </div>
                <p className="text-base text-ink-2">{info.why}</p>
                <p className="flex items-start gap-1.5 text-sm text-ink-3">
                  {done && <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-positive" />}
                  <span>{state.detail}</span>
                </p>
                {step === "teachers" &&
                  path === "switch" &&
                  allowed(ctx, "staff.manage") &&
                  ctx.campusIds === null && (
                    <p className="text-sm">
                      <Link href={schoolPath(slug, "staff/import")} className="text-accent hover:underline">
                        Import your staff list
                      </Link>
                    </p>
                  )}
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
