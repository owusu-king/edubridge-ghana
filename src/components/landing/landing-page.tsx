import { ArrowRight, Check, Plus } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonStyles } from "@/components/ui/button";
import { Wordmark } from "@/components/ui/wordmark";
import { requestVisitAction, startDemoAction } from "@/app/landing-actions";
import { cn } from "@/lib/cn";
import { CORE_MODULE_IDS, MODULES } from "@/lib/modules";
import { SUGGESTED_ADD_ONS, SUGGESTED_PLANS } from "@/lib/pricing";
import {
  ACADEMICS,
  FAQ,
  FINANCE,
  HERO,
  INSIGHT,
  INTELLIGENCE,
  OPERATIONS,
  PILLARS,
  PRICING,
  PROBLEMS,
  TRUST,
  VISIT,
  WORLD,
} from "./content";
import { DemoButton } from "./demo-button";
import { EnquiryForm } from "./enquiry-form";
import { InstalledRedirect } from "./installed-redirect";
import { IntroVideo } from "./intro-video";
import { AcademicsPreview, CommandCenterPreview, EarlyWarningPreview, InsightPreview } from "./previews";
import { ProductPreview } from "./product-preview";

/*
 * The public landing page (2026-11-19, second direction): EduBridge as the complete operating system for schools.
 * The story runs from the owner's problems, to one connected platform, to its strongest parts (student intelligence,
 * management insight, finance, academics), the breadth of operations, why it can be trusted, where it works, and
 * how to try it. Product pictures are drawn from the app's own design and marked as examples; the words live in
 * content.ts; plan contents come from the code. No stock photographs, statistics or testimonials.
 */

export interface LandingOptions {
  /** "Explore the demo school" is offered (the deployment names a demo school that has its visitor). */
  demo: boolean;
  video: { src: string | null; poster: string | null };
  /** Optional ways to reach EduBridge, from the deployment's settings. */
  contact: { phone: string | null; whatsapp: string | null; email: string | null };
}

const NAV: { label: string; href: string }[] = [
  { label: "Platform", href: "#platform" },
  { label: "Intelligence", href: "#intelligence" },
  { label: "Finance", href: "#finance" },
  { label: "Academics", href: "#academics" },
  { label: "Trust", href: "#trust" },
  { label: "Pricing", href: "#pricing" },
];

/** Section headings; the colour is set where each is used (the world section is on a dark band). */
const H2 = "font-display text-[1.875rem] leading-[1.12] font-medium tracking-tight sm:text-[2.5rem]";

function Heading({
  id,
  eyebrow,
  title,
  lead,
  center,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  lead?: string;
  center?: boolean;
}) {
  return (
    <div className={cn("max-w-2xl", center && "mx-auto text-center")}>
      <p className="text-sm font-medium text-accent">{eyebrow}</p>
      <h2 id={id} className={cn("mt-3 text-ink", H2)}>
        {title}
      </h2>
      {lead && <p className="mt-4 text-md leading-relaxed text-ink-2">{lead}</p>}
    </div>
  );
}

function Shell({
  id,
  labelledBy,
  className,
  children,
}: {
  id?: string;
  labelledBy?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cn("scroll-mt-20 py-20 sm:py-28", className)}>
      <div className="mx-auto max-w-6xl px-5 sm:px-8">{children}</div>
    </section>
  );
}

function Points({ items }: { items: string[] }) {
  return (
    <ul className="mt-8 space-y-4">
      {items.map((p) => (
        <li key={p} className="flex gap-3 text-base leading-relaxed text-ink-2">
          <Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-positive" />
          <span>{p}</span>
        </li>
      ))}
    </ul>
  );
}

/** Text on one side, the product on the other; `flip` puts the picture first on wide screens. */
function Feature({
  id,
  eyebrow,
  title,
  lead,
  points,
  picture,
  flip,
  className,
}: {
  id: string;
  eyebrow: string;
  title: string;
  lead: string;
  points: string[];
  picture: ReactNode;
  flip?: boolean;
  className?: string;
}) {
  return (
    <Shell id={id} labelledBy={`${id}-title`} className={className}>
      <div className="grid items-center gap-14 lg:grid-cols-2 lg:gap-20">
        <div className={cn(flip && "lg:order-2")}>
          <Heading id={`${id}-title`} eyebrow={eyebrow} title={title} lead={lead} />
          <Points items={points} />
        </div>
        <div className={cn(flip && "lg:order-1")}>{picture}</div>
      </div>
    </Shell>
  );
}

export function LandingPage({ demo, video, contact }: LandingOptions) {
  const year = new Date().getFullYear();
  const showVideo = Boolean(video.src) || process.env.NODE_ENV !== "production";
  const moduleName = (id: string) => MODULES[id as keyof typeof MODULES]?.name ?? id;
  const ctaPrimary = buttonStyles("primary", "md", "h-11 px-5");
  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <InstalledRedirect />
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur supports-[backdrop-filter]:bg-canvas/75">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5 sm:px-8">
          <Link href="/" aria-label="EduBridge home" className="shrink-0">
            <Wordmark />
          </Link>
          <nav aria-label="Main" className="hidden flex-1 items-center gap-0.5 lg:flex">
            {NAV.map((n) => (
              <a
                key={n.href}
                href={n.href}
                className="rounded-md px-3 py-2 text-base text-ink-2 transition-colors hover:bg-subtle hover:text-ink"
              >
                {n.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link
              href={"/login" as Route}
              className="rounded-md px-3 py-2 text-base font-medium text-ink-2 transition-colors hover:bg-subtle hover:text-ink"
            >
              Sign in
            </Link>
            <a href="#visit" className={buttonStyles("primary", "sm")}>
              Book a demo
            </a>
          </div>
        </div>
      </header>

      <main id="main">
        {/* 1. What EduBridge is, for whom, and why to look further. */}
        <section className="overflow-hidden">
          <div className="mx-auto grid max-w-6xl items-center gap-14 px-5 pt-14 pb-20 sm:px-8 sm:pt-20 lg:grid-cols-[1fr_1.05fr] lg:gap-16 lg:pb-28">
            <div>
              <p className="text-sm font-medium text-accent">{HERO.audience}</p>
              <h1 className="mt-4 font-display text-[2.5rem] leading-[1.04] font-medium tracking-tight text-ink sm:text-[3.5rem]">
                {HERO.title}
              </h1>
              <p className="mt-4 font-display text-xl text-ink-2 sm:text-[1.625rem]">{HERO.tagline}</p>
              <p className="mt-6 max-w-xl text-md leading-relaxed text-ink-2">{HERO.lead}</p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <a href="#visit" className={ctaPrimary}>
                  Book a demo
                </a>
                {demo ? (
                  <DemoButton action={startDemoAction} label="Explore the demo school" />
                ) : (
                  <a href="#platform" className={buttonStyles("secondary", "md", "h-11 px-5")}>
                    See the platform
                  </a>
                )}
              </div>
              <p className="mt-5 flex items-center gap-2 text-sm text-ink-2">
                <Check aria-hidden="true" className="size-4 text-positive" />
                {HERO.pilot} {demo && "The demo school is open to look round, with no sign-up."}
              </p>
            </div>
            <CommandCenterPreview />
          </div>
        </section>

        {/* 2. The problems an owner lives with. */}
        <Shell labelledBy="problems-title" className="border-t border-line bg-surface/60">
          <div className="grid gap-12 lg:grid-cols-[1fr_1.5fr] lg:gap-20">
            <Heading
              id="problems-title"
              eyebrow="Why schools need it"
              title="Running a school should not depend on guesswork."
              lead="The questions every owner asks, and how EduBridge answers them."
            />
            <dl className="divide-y divide-line border-y border-line">
              {PROBLEMS.map((p) => (
                <div key={p.problem} className="grid gap-2 py-5 sm:grid-cols-[1fr_1.4fr] sm:gap-8">
                  <dt className="font-display text-lg text-ink">{p.problem}</dt>
                  <dd className="text-base leading-relaxed text-ink-2">{p.answer}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Shell>

        {/* 3. One connected platform. */}
        <Shell id="platform" labelledBy="platform-title" className="border-t border-line">
          <Heading
            id="platform-title"
            eyebrow="One platform"
            title="Every part of the school, on one set of records."
            lead="A payment, a register or a mark is entered once and is right everywhere: for the owner, the office, the classroom and the family. No separate apps to reconcile."
          />
          <ul className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
            {PILLARS.map(({ icon: Icon, title, body, href }) => (
              <li key={title} className="bg-surface">
                <a
                  href={href}
                  className="group flex h-full flex-col gap-4 p-6 transition-colors hover:bg-subtle/50 sm:p-7"
                >
                  <span className="flex size-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
                    <Icon aria-hidden="true" className="size-5" strokeWidth={1.75} />
                  </span>
                  <span>
                    <span className="block text-md font-semibold text-ink">{title}</span>
                    <span className="mt-1 block text-base text-ink-2">{body}</span>
                  </span>
                  <ArrowRight
                    aria-hidden="true"
                    className="mt-auto size-4 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-accent"
                  />
                </a>
              </li>
            ))}
          </ul>
        </Shell>

        {/* 4. Student intelligence. */}
        <Feature
          id="intelligence"
          className="border-t border-line bg-surface/60"
          eyebrow={INTELLIGENCE.eyebrow}
          title={INTELLIGENCE.title}
          lead={INTELLIGENCE.lead}
          points={INTELLIGENCE.points}
          picture={<EarlyWarningPreview />}
        />

        {/* 5. Management insight. */}
        <Feature
          id="insight"
          className="border-t border-line"
          eyebrow={INSIGHT.eyebrow}
          title={INSIGHT.title}
          lead={INSIGHT.lead}
          points={INSIGHT.points}
          picture={<InsightPreview />}
          flip
        />

        {/* 6. Finance and accountability. */}
        <Shell id="finance" labelledBy="finance-title" className="border-t border-line bg-surface/60">
          <div className="grid items-center gap-14 lg:grid-cols-[1fr_1.05fr] lg:gap-20">
            <Heading id="finance-title" eyebrow={FINANCE.eyebrow} title={FINANCE.title} lead={FINANCE.lead} />
            <ProductPreview />
          </div>
          <ol className="mt-16 grid gap-x-12 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {FINANCE.points.map((p, i) => (
              <li key={p.title} className="border-t border-line pt-6">
                <span aria-hidden="true" className="font-display text-base text-ink-3 tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="mt-2 text-md font-semibold text-ink">{p.title}</h3>
                <p className="mt-1.5 text-base leading-relaxed text-ink-2">{p.body}</p>
              </li>
            ))}
          </ol>
        </Shell>

        {/* 7. Academics and the Student Passport. */}
        <Shell id="academics" labelledBy="academics-title" className="border-t border-line">
          <div className="grid items-center gap-14 lg:grid-cols-2 lg:gap-20">
            <div className="lg:order-2">
              <Heading
                id="academics-title"
                eyebrow={ACADEMICS.eyebrow}
                title={ACADEMICS.title}
                lead={ACADEMICS.lead}
              />
              <Points items={ACADEMICS.points} />
              <div className="mt-8 rounded-xl border border-accent/30 bg-accent-soft/50 p-5">
                <p className="text-md font-semibold text-ink">{ACADEMICS.passport.title}</p>
                <p className="mt-1.5 text-base leading-relaxed text-ink-2">{ACADEMICS.passport.body}</p>
              </div>
            </div>
            <div className="lg:order-1">
              <AcademicsPreview />
            </div>
          </div>
        </Shell>

        {/* 8. The breadth of operations. */}
        <Shell id="operations" labelledBy="operations-title" className="border-t border-line bg-surface/60">
          <Heading
            id="operations-title"
            eyebrow={OPERATIONS.eyebrow}
            title={OPERATIONS.title}
            lead={OPERATIONS.lead}
          />
          <div className="mt-14 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            {OPERATIONS.groups.map((g) => (
              <div key={g.title}>
                <h3 className="text-sm font-semibold text-ink">{g.title}</h3>
                <ul className="mt-3 divide-y divide-line border-y border-line">
                  {g.items.map((item) => (
                    <li key={item} className="py-2.5 text-base text-ink-2">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Shell>

        {/* 9. Trust. */}
        <Shell id="trust" labelledBy="trust-title" className="border-t border-line">
          <div className="grid gap-12 lg:grid-cols-[1fr_1.6fr] lg:gap-20">
            <div>
              <Heading id="trust-title" eyebrow={TRUST.eyebrow} title={TRUST.title} lead={TRUST.lead} />
              <Link
                href={"/trust" as Route}
                className="mt-8 inline-flex items-center gap-1.5 text-base font-medium text-accent hover:underline"
              >
                How we protect school data
                <ArrowRight aria-hidden="true" className="size-4" />
              </Link>
            </div>
            <dl className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
              {TRUST.points.map((p) => (
                <div key={p.title} className="border-t border-line pt-5">
                  <dt className="text-md font-semibold text-ink">{p.title}</dt>
                  <dd className="mt-1.5 text-base leading-relaxed text-ink-2">{p.body}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Shell>

        {/* 10. Built for Africa, ready for the world. */}
        <Shell id="world" labelledBy="world-title" className="border-t border-line bg-ink text-canvas">
          <div className="max-w-2xl">
            <p className="text-sm font-medium text-canvas/70">{WORLD.eyebrow}</p>
            <h2 id="world-title" className={cn("mt-3", H2, "text-canvas")}>
              {WORLD.title}
            </h2>
            <p className="mt-4 text-md leading-relaxed text-canvas/75">{WORLD.lead}</p>
          </div>
          <ul className="mt-10 flex flex-wrap gap-2" aria-label="Country settings ready">
            {WORLD.countries.map((c) => (
              <li key={c} className="rounded-full border border-canvas/20 px-3 py-1 text-sm text-canvas/85">
                {c}
              </li>
            ))}
          </ul>
          <dl className="mt-14 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
            {WORLD.facts.map((f) => (
              <div key={f.title} className="border-t border-canvas/20 pt-5">
                <dt className="text-md font-semibold text-canvas">{f.title}</dt>
                <dd className="mt-1.5 text-base leading-relaxed text-canvas/70">{f.body}</dd>
              </div>
            ))}
          </dl>
        </Shell>

        {/* 11. Pricing: the plans as the code defines them; prices on request. */}
        <Shell id="pricing" labelledBy="pricing-title">
          <Heading
            id="pricing-title"
            eyebrow={PRICING.eyebrow}
            title={PRICING.title}
            lead={PRICING.body}
            center
          />
          <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-3">
            {SUGGESTED_PLANS.map((plan, i) => {
              const previous = SUGGESTED_PLANS[i - 1];
              const shown = previous
                ? plan.features.filter((f) => !previous.features.includes(f))
                : plan.features;
              return (
                <div
                  key={plan.name}
                  className={cn("flex flex-col bg-surface p-7 sm:p-8", i === 1 && "bg-accent-soft/40")}
                >
                  <h3 className="font-display text-xl text-ink">{plan.name}</h3>
                  <p className="mt-2 text-base text-ink-2">{plan.description}</p>
                  <p className="mt-5 text-sm text-ink-3">
                    Up to {plan.maxCampuses} {plan.maxCampuses === 1 ? "campus" : "campuses"} ·{" "}
                    {plan.maxSmsPerMonth.toLocaleString("en-GB")} SMS a month
                  </p>
                  <p className="mt-5 border-t border-line pt-5 text-xs font-medium text-ink-3">
                    {previous ? `Everything in ${previous.name}, plus` : "Includes"}
                  </p>
                  <ul className="mt-3 space-y-2">
                    {shown.map((f) => (
                      <li key={f} className="flex gap-2 text-sm text-ink-2">
                        <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-positive" />
                        {moduleName(f)}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
          <div className="mt-8 grid gap-6 text-sm text-ink-2 md:grid-cols-2">
            <p>
              <span className="font-medium text-ink">In every plan: </span>
              {CORE_MODULE_IDS.map(moduleName).join(", ")}.
            </p>
            <p>
              <span className="font-medium text-ink">Add when you need them: </span>
              {SUGGESTED_ADD_ONS.map((a) => moduleName(a.module)).join(", ")}.
            </p>
          </div>
          <div className="mt-10 flex justify-center">
            <a href="#visit" className={ctaPrimary}>
              Ask for a quote
            </a>
          </div>
        </Shell>

        {/* 12. Try it: the video and the demo school. */}
        <Shell id="demo" labelledBy="demo-title" className="border-t border-line bg-surface/60">
          <Heading
            id="demo-title"
            eyebrow="See it for yourself"
            title="Look round a working school before you talk to anyone."
            lead={
              demo
                ? "The demo school is a complete school with a term of made-up records: fees, registers, report cards, finances and more. Look at everything; nothing you do there can change it."
                : "A short tour of a school's day on EduBridge, from the morning register to the evening's fees."
            }
            center
          />
          {showVideo && (
            <div className="mx-auto mt-12 max-w-4xl">
              <IntroVideo src={video.src} poster={video.poster} />
            </div>
          )}
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            {demo && (
              <DemoButton action={startDemoAction} label="Explore the demo school" variant="primary" />
            )}
            <a href="#visit" className={buttonStyles(demo ? "secondary" : "primary", "md", "h-11 px-5")}>
              Book a demo
            </a>
          </div>
        </Shell>

        {/* 13. Questions. */}
        <Shell id="faq" labelledBy="faq-title" className="border-t border-line">
          <div className="grid gap-12 lg:grid-cols-[1fr_1.6fr] lg:gap-20">
            <Heading id="faq-title" eyebrow="Questions" title="What school owners ask first." />
            <div className="divide-y divide-line border-y border-line">
              {FAQ.map((f) => (
                <details key={f.q} className="group py-5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-md font-medium text-ink [&::-webkit-details-marker]:hidden">
                    {f.q}
                    <Plus
                      aria-hidden="true"
                      className="size-4 shrink-0 text-ink-3 transition-transform group-open:rotate-45"
                    />
                  </summary>
                  <p className="mt-3 max-w-2xl text-base leading-relaxed text-ink-2">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </Shell>

        {/* 14. The next step. */}
        <section
          id="visit"
          aria-labelledby="visit-title"
          className="scroll-mt-20 border-t border-line bg-surface/60 py-20 sm:py-28"
        >
          <div className="mx-auto grid max-w-6xl gap-12 px-5 sm:px-8 lg:grid-cols-[1fr_1.35fr] lg:gap-20">
            <div>
              <h2 id="visit-title" className={cn("text-ink", H2)}>
                {VISIT.title}
              </h2>
              <p className="mt-4 text-md leading-relaxed text-ink-2">{VISIT.body}</p>
              <p className="mt-6 flex items-center gap-2 text-sm text-ink-2">
                <Check aria-hidden="true" className="size-4 text-positive" />
                {HERO.pilot}
              </p>
              {(contact.phone || contact.whatsapp || contact.email) && (
                <dl className="mt-8 space-y-4 border-t border-line pt-6 text-base">
                  {contact.whatsapp && (
                    <div>
                      <dt className="text-sm text-ink-3">WhatsApp</dt>
                      <dd>
                        <a
                          href={`https://wa.me/${contact.whatsapp}`}
                          className="font-medium text-accent hover:underline"
                          rel="noopener"
                        >
                          Message us on WhatsApp
                        </a>
                      </dd>
                    </div>
                  )}
                  {contact.phone && (
                    <div>
                      <dt className="text-sm text-ink-3">Call</dt>
                      <dd>
                        <a
                          href={`tel:${contact.phone.replace(/\s+/g, "")}`}
                          className="font-medium text-ink hover:underline"
                        >
                          {contact.phone}
                        </a>
                      </dd>
                    </div>
                  )}
                  {contact.email && (
                    <div>
                      <dt className="text-sm text-ink-3">Email</dt>
                      <dd>
                        <a href={`mailto:${contact.email}`} className="font-medium text-ink hover:underline">
                          {contact.email}
                        </a>
                      </dd>
                    </div>
                  )}
                </dl>
              )}
            </div>
            <EnquiryForm action={requestVisitAction} />
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 sm:px-8 md:grid-cols-[1.2fr_1fr_1fr]">
          <div>
            <Wordmark />
            <p className="mt-3 max-w-xs text-sm text-ink-3">
              The complete operating system for schools. Built for Africa. Ready for the world.
            </p>
          </div>
          <nav aria-label="Product" className="flex flex-col gap-2 text-sm text-ink-2">
            <span className="font-medium text-ink">Product</span>
            {NAV.slice(0, 4).map((n) => (
              <a key={n.href} href={n.href} className="hover:text-ink hover:underline">
                {n.label}
              </a>
            ))}
          </nav>
          <nav aria-label="Footer" className="flex flex-col gap-2 text-sm text-ink-2">
            <span className="font-medium text-ink">EduBridge</span>
            <Link href={"/trust" as Route} className="hover:text-ink hover:underline">
              How we protect school data
            </Link>
            <Link href={"/login" as Route} className="hover:text-ink hover:underline">
              Staff sign in
            </Link>
            <Link href={"/p/login" as Route} className="hover:text-ink hover:underline">
              Parent sign in
            </Link>
            <Link href={"/verify" as Route} className="hover:text-ink hover:underline">
              Check a student record
            </Link>
          </nav>
        </div>
        <div className="mx-auto max-w-6xl border-t border-line px-5 py-5 text-xs text-ink-3 sm:px-8">
          © {year} EduBridge
        </div>
      </footer>
    </div>
  );
}
