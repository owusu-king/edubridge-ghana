import { Banknote, Radar, ShieldCheck, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/*
 * Pictures of the product for the landing page (2026-11-19): the Command Center, early warning, insights and an
 * academic record, drawn with the app's own type, colours and layout rather than as screenshots, so they stay sharp,
 * light on data and correct in both themes. Every name and figure is made up and each picture says so; they are
 * hidden from screen readers, which get the caption instead.
 */

export function Frame({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-line bg-surface shadow-overlay", className)}>
      <div className="flex h-9 items-center gap-1.5 border-b border-line bg-subtle/60 px-4">
        <span className="size-2 rounded-full bg-line-strong" />
        <span className="size-2 rounded-full bg-line-strong" />
        <span className="size-2 rounded-full bg-line-strong" />
        <span className="ml-3 truncate text-xs text-ink-3">{title}</span>
      </div>
      {children}
    </div>
  );
}

export function Example({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <figure className={className}>
      <div aria-hidden="true">{children}</div>
      <figcaption className="mt-3 text-right text-xs text-ink-3">
        An example school. Every name and figure is made up.
      </figcaption>
    </figure>
  );
}

const WEEKS = [42, 61, 28, 19, 44, 33, 22, 18, 25, 15, 21];

/** The hero: one screen with the term's money, attendance and marks, and what needs the owner's attention. */
export function CommandCenterPreview() {
  const max = Math.max(...WEEKS);
  return (
    <Example>
      <Frame title="Command Center · Term 1, 2026/2027">
        <div className="space-y-5 p-5 sm:p-6">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
            {[
              ["Fees collected", "77%", "GH₵ 318,240"],
              ["Attendance", "94.2%", "this term"],
              ["Report cards", "9 of 11", "classes ready"],
              ["Students", "412", "in 11 classes"],
            ].map(([label, value, note]) => (
              <div key={label} className="min-w-0">
                <dt className="text-xs text-ink-3">{label}</dt>
                <dd className="mt-0.5 text-lg font-semibold text-ink tabular-nums">{value}</dd>
                <dd className="truncate text-xs text-ink-3">{note}</dd>
              </div>
            ))}
          </dl>
          <div>
            <p className="text-xs font-medium text-ink-3">Collected each week</p>
            <div className="mt-2 flex h-20 items-end gap-1.5">
              {WEEKS.map((w, i) => (
                <span
                  key={i}
                  className="flex-1 rounded-t-sm bg-accent/80"
                  style={{ height: `${Math.round((w / max) * 100)}%` }}
                />
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-ink-3">Needs your attention</p>
            <ul className="mt-2 divide-y divide-line border-y border-line">
              {(
                [
                  [TriangleAlert, "text-caution", "GH₵ 3,420.00 in cash not banked", "held 4 days"],
                  [Radar, "text-accent", "4 students flagged by early warning", "Basic 6, JHS 2"],
                  [Banknote, "text-ink-3", "2 expenses waiting for your approval", "GH₵ 6,150.00"],
                ] as [LucideIcon, string, string, string][]
              ).map(([Icon, tone, text, note]) => (
                <li key={text} className="flex items-center gap-3 py-2.5 text-sm">
                  <Icon className={cn("size-4 shrink-0", tone)} />
                  <span className="min-w-0 flex-1 truncate text-ink">{text}</span>
                  <span className="hidden shrink-0 text-xs text-ink-3 sm:block">{note}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Frame>
    </Example>
  );
}

/** Early warning: students listed with the evidence, reviewed by a teacher, with a support plan. */
export function EarlyWarningPreview() {
  const rows = [
    {
      name: "Kwesi Mensah",
      cls: "JHS 2A",
      flags: ["Attendance 76% over 28 days", "Absent 3 days in a row"],
      status: "Support plan · review 2 Dec",
      tone: "text-positive",
    },
    {
      name: "Efua Darko",
      cls: "Basic 6B",
      flags: ["Average down 12 points", "2 subjects below 50"],
      status: "Waiting for the class teacher",
      tone: "text-caution",
    },
    {
      name: "Yaw Boateng",
      cls: "JHS 2A",
      flags: ["Average down 10 points"],
      status: "Reviewed: no action needed",
      tone: "text-ink-3",
    },
  ];
  return (
    <Example>
      <Frame title="Early warning · this term">
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.name} className="space-y-2 px-5 py-4 sm:px-6">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-base font-medium text-ink">
                  {r.name} <span className="text-sm font-normal text-ink-3">· {r.cls}</span>
                </p>
                <p className={cn("shrink-0 text-xs", r.tone)}>{r.status}</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {r.flags.map((f) => (
                  <span
                    key={f}
                    className="rounded-md border border-line bg-subtle/60 px-2 py-0.5 text-xs text-ink-2"
                  >
                    {f}
                  </span>
                ))}
              </div>
            </li>
          ))}
        </ul>
      </Frame>
    </Example>
  );
}

/** Insights: collections so far and the forecast from past terms, with attendance by level. */
export function InsightPreview() {
  // Collected so far (solid), likely (dashed) and the range (band), as shares of a 100-high chart.
  const actual = "0,96 30,80 60,62 90,50 120,43 150,37";
  const likely = "150,37 180,31 210,26 240,22 270,19";
  const band = "150,37 180,26 210,18 240,12 270,8 270,30 240,32 210,34 180,35 150,37";
  return (
    <Example>
      <Frame title="Insights · fee collection">
        <div className="space-y-5 p-5 sm:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-xs text-ink-3">Likely by the end of term</p>
              <p className="text-lg font-semibold text-ink tabular-nums">GH₵ 371,900</p>
            </div>
            <p className="text-xs text-ink-3">From your last 4 terms · range GH₵ 352,000 to 389,500</p>
          </div>
          <svg viewBox="0 0 270 100" className="h-28 w-full overflow-visible" preserveAspectRatio="none">
            <polygon points={band} className="fill-accent/25" />
            <polyline
              points={actual}
              className="fill-none stroke-accent"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
            />
            <polyline
              points={likely}
              className="fill-none stroke-accent"
              strokeWidth="2"
              strokeDasharray="4 4"
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1="150"
              x2="150"
              y1="0"
              y2="100"
              className="stroke-line-strong"
              strokeDasharray="2 3"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <div className="flex gap-5 text-xs text-ink-3">
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 bg-accent" /> Collected
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 border-t-2 border-dashed border-accent" /> Likely
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-4 rounded-sm bg-accent/25" /> Range
            </span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-ink-3">
                <th className="pb-1.5 font-normal">Attendance by level</th>
                <th className="pb-1.5 text-right font-normal">This term</th>
                <th className="pb-1.5 text-right font-normal">Last term</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line border-y border-line">
              {[
                ["Basic 1 to 3", "96.1%", "95.4%"],
                ["Basic 4 to 6", "94.8%", "95.0%"],
                ["JHS 1 to 3", "91.7%", "93.2%"],
              ].map(([level, now, before]) => (
                <tr key={level}>
                  <td className="py-2 text-ink">{level}</td>
                  <td className="py-2 text-right text-ink tabular-nums">{now}</td>
                  <td className="py-2 text-right text-ink-3 tabular-nums">{before}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Frame>
    </Example>
  );
}

/** Academics: a JHS report card's core, its BECE-style aggregate, and the record's signature. */
export function AcademicsPreview() {
  const subjects = [
    ["English Language", "82", "2"],
    ["Mathematics", "91", "1"],
    ["Integrated Science", "76", "3"],
    ["Social Studies", "68", "4"],
    ["Computing", "93", "1"],
    ["French", "84", "2"],
  ];
  return (
    <Example>
      <div className="relative">
        <Frame title="Report card · JHS 3B · Term 1">
          <div className="p-5 sm:p-6">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-base font-medium text-ink">Abena Owusu</p>
              <p className="text-xs text-ink-3">Position 4 of 36</p>
            </div>
            <table className="mt-4 w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-ink-3">
                  <th className="pb-1.5 font-normal">Subject</th>
                  <th className="pb-1.5 text-right font-normal">Score</th>
                  <th className="pb-1.5 text-right font-normal">Grade</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line border-y border-line">
                {subjects.map(([s, score, grade]) => (
                  <tr key={s}>
                    <td className="py-2 text-ink">{s}</td>
                    <td className="py-2 text-right text-ink tabular-nums">{score}</td>
                    <td className="py-2 text-right text-ink tabular-nums">{grade}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 flex items-center justify-between text-sm">
              <span className="text-ink-2">Aggregate (best six)</span>
              <span className="font-semibold text-ink tabular-nums">13</span>
            </p>
          </div>
        </Frame>
        <div className="relative -mt-3 mr-4 ml-auto w-64 max-w-[calc(100%-2rem)] rounded-lg border border-line bg-surface p-4 shadow-overlay">
          <div className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-positive" />
            <div className="text-sm">
              <p className="font-medium text-ink">Student Passport verified</p>
              <p className="mt-1 text-ink-2">
                Signed by EduBridge for the issuing school, and unchanged since.
              </p>
            </div>
          </div>
        </div>
      </div>
    </Example>
  );
}
