import type { Route } from "next";
import Link from "next/link";
import { CalendarOff } from "lucide-react";
import type { ReactNode } from "react";
import { ScoreRing } from "@/components/charts/rings";
import { DonutBreakdown, type DonutSegment } from "@/components/charts/rings-interactive";
import { cn } from "@/lib/cn";

/*
 * The panels that open the Overview's Attendance and Students sections: rings for the headline shares,
 * plain figures for the counts, in one hairline-divided panel.
 */

function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid overflow-hidden rounded-lg border border-line bg-surface", className)}>
      {children}
    </div>
  );
}

/** A cell of the panel; cells after the first are divided by hairlines, across or down as the grid wraps. */
function Cell({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("min-w-0 border-line p-5", className)}>{children}</div>;
}

/** A ring with its title and a line of detail beside it. */
function RingFigure({ ring, title, detail }: { ring: ReactNode; title: ReactNode; detail: ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      {ring}
      <div className="min-w-0">
        <p className="text-md font-medium text-ink">{title}</p>
        <p className="mt-0.5 text-sm text-ink-3">{detail}</p>
      </div>
    </div>
  );
}

/** A count with its label above and a note below. */
interface FigureProps {
  label: string;
  value: string;
  note?: ReactNode;
  href?: string;
}

function Count({ label, value, note, href }: FigureProps) {
  return (
    <>
      <p className="text-sm text-ink-3">{label}</p>
      {href ? (
        <Link
          href={href as Route}
          className="mt-1 inline-block font-display text-xl text-ink tabular-nums decoration-line-strong underline-offset-4 transition-colors hover:text-accent hover:underline"
        >
          {value}
        </Link>
      ) : (
        <p className="mt-1 font-display text-xl text-ink tabular-nums">{value}</p>
      )}
      {note && <p className="mt-1 text-sm text-ink-3">{note}</p>}
    </>
  );
}

export function AttendanceSummary({
  rate,
  absentDays,
  today,
  concernPercent,
  concernMinDays,
  concernCount,
  classes,
  registersHref,
}: {
  rate: number | null;
  absentDays: number;
  today: { taken: number; classes: number } | null;
  concernPercent: number;
  concernMinDays: number;
  concernCount: number;
  classes: number;
  registersHref: string;
}) {
  const todayShare = today && today.classes > 0 ? (today.taken / today.classes) * 100 : null;
  const allTaken = today !== null && today.classes > 0 && today.taken === today.classes;
  return (
    <Panel className="grid-cols-2 lg:grid-cols-[1.35fr_1.35fr_1fr_1fr]">
      <Cell className="col-span-2 sm:col-span-1">
        <RingFigure
          ring={
            <ScoreRing
              label="Attendance this term"
              value={rate}
              display={rate === null ? "—" : `${rate}%`}
              tone={rate !== null && rate < concernPercent ? "caution" : "positive"}
            />
          }
          title="This term"
          detail={`${absentDays} days absent in all`}
        />
      </Cell>
      <Cell className="col-span-2 border-t sm:col-span-1 sm:border-t-0 sm:border-l">
        <RingFigure
          ring={
            <ScoreRing
              label="Today's registers taken"
              value={todayShare}
              display={today ? `${today.taken}/${today.classes}` : ""}
              tone={allTaken ? "positive" : "accent"}
              empty={<CalendarOff aria-hidden="true" strokeWidth={1.5} />}
            />
          }
          title={
            <Link
              href={registersHref as Route}
              className="transition-colors hover:text-accent hover:underline"
            >
              Today&apos;s registers
            </Link>
          }
          detail={
            today === null
              ? "Today is not in this term"
              : allTaken
                ? "All taken"
                : `${today.classes - today.taken} still to take`
          }
        />
      </Cell>
      <Cell className="border-t lg:border-t-0 lg:border-l">
        <Count
          label={`Below ${concernPercent}% attendance`}
          value={String(concernCount)}
          note={`Students on ${concernMinDays} or more registers`}
        />
      </Cell>
      <Cell className="border-t border-l lg:border-t-0">
        <Count label="Classes" value={String(classes)} />
      </Cell>
    </Panel>
  );
}

/** The term's collection rate as a ring, with the money figures behind it beside it. */
export function FeesSummary({
  rate,
  rateNote,
  figures,
}: {
  rate: number | null;
  rateNote: string;
  /** Billed, collected and paid after a reminder, in that order. */
  figures: [FigureProps, FigureProps, FigureProps];
}) {
  const [first, second, third] = figures;
  return (
    <Panel className="sm:grid-cols-2 lg:grid-cols-[1.3fr_1fr_1fr_1fr]">
      <Cell>
        <RingFigure
          ring={
            <ScoreRing
              label="Collection rate"
              value={rate}
              display={rate === null ? "—" : `${rate}%`}
              tone="accent"
            />
          }
          title="Collection rate"
          detail={rateNote}
        />
      </Cell>
      <Cell className="border-t sm:border-t-0 sm:border-l">
        <Count {...first} />
      </Cell>
      <Cell className="border-t lg:border-t-0 lg:border-l">
        <Count {...second} />
      </Cell>
      <Cell className="border-t sm:border-l lg:border-t-0">
        <Count {...third} />
      </Cell>
    </Panel>
  );
}

/** Marks entered and report cards published this term, as two rings. */
export function ReportCardSummary({
  complete,
  classes,
  published,
  students,
}: {
  complete: number;
  classes: number;
  published: number;
  students: number;
}) {
  const share = (n: number, of: number) => (of > 0 ? (n / of) * 100 : null);
  const publishedShare = share(published, students);
  return (
    <Panel className="sm:grid-cols-2">
      <Cell>
        <RingFigure
          ring={
            <ScoreRing
              label="Classes with every mark entered"
              value={share(complete, classes)}
              display={`${complete}/${classes}`}
              tone={classes > 0 && complete === classes ? "positive" : "accent"}
            />
          }
          title="Classes with every mark"
          detail={
            complete === classes ? "All classes complete" : `${classes - complete} still entering marks`
          }
        />
      </Cell>
      <Cell className="border-t sm:border-t-0 sm:border-l">
        <RingFigure
          ring={
            <ScoreRing
              label="Report cards published"
              value={publishedShare}
              display={publishedShare === null ? "—" : `${Math.round(publishedShare)}%`}
              tone={students > 0 && published === students ? "positive" : "accent"}
            />
          }
          title="Report cards published"
          detail={`${published} of ${students} students`}
        />
      </Cell>
    </Panel>
  );
}

export function EnrolmentSummary({
  total,
  female,
  male,
  levels,
  studentsHref,
  classesHref,
}: {
  total: number;
  female: number;
  male: number;
  levels: { name: string; total: number }[];
  studentsHref: string;
  classesHref: string;
}) {
  const unrecorded = Math.max(0, total - female - male);
  const segments: DonutSegment[] = [
    { label: "Girls", value: female, tone: "accent" },
    { label: "Boys", value: male, tone: "positive" },
    ...(unrecorded > 0 ? [{ label: "Not recorded", value: unrecorded, tone: "neutral" as const }] : []),
  ];
  // The biggest level, saying so honestly when several (or all) share the top size.
  const most = Math.max(0, ...levels.map((l) => l.total));
  const top = levels.filter((l) => l.total === most);
  const sizes =
    levels.length === 0
      ? { label: "Largest level", value: "—", note: undefined }
      : levels.length > 1 && top.length === levels.length
        ? { label: "Students per level", value: String(most), note: "Every level is the same size" }
        : {
            label: "Largest level",
            value: top[0]!.name,
            note:
              top.length > 1
                ? `${most} students, the same as ${top.length - 1} other level${top.length > 2 ? "s" : ""}`
                : `${most} students`,
          };
  return (
    <Panel className="grid-cols-2 lg:grid-cols-[2fr_1fr_1fr]">
      <Cell className="col-span-2 lg:col-span-1">
        <DonutBreakdown
          label="Students in classes"
          total={total}
          caption="students"
          segments={segments}
          footer={
            <div className="mt-1.5 flex items-center gap-2 border-t border-line pt-2.5 text-sm">
              <span aria-hidden="true" className="size-2" />
              <dt className="flex-1 text-ink-2">In classes</dt>
              <dd>
                <Link
                  href={studentsHref as Route}
                  className="font-medium text-ink tabular-nums transition-colors hover:text-accent hover:underline"
                >
                  {total}
                </Link>
                <span className="ml-2 inline-block w-9" />
              </dd>
            </div>
          }
        />
      </Cell>
      <Cell className="border-t lg:border-t-0 lg:border-l">
        <Count
          label="Levels"
          value={String(levels.length)}
          href={classesHref}
          note="With students this term"
        />
      </Cell>
      <Cell className="border-t border-l lg:border-t-0">
        <Count label={sizes.label} value={sizes.value} note={sizes.note} />
      </Cell>
    </Panel>
  );
}
