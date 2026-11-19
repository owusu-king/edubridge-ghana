import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, FileText } from "lucide-react";
import { StatusText } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { DescriptionList, Section } from "@/components/ui/layout";
import { admissionOptions, getApplication } from "@/server/admissions/service";
import { db } from "@/server/db/client";
import { APPLICATION_SOURCE_LABELS, APPLICATION_STATUS_LABELS } from "@/lib/admissions";
import { formatCalendarDate, formatDateTime } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { formatPhone } from "@/lib/phone";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import {
  enrolAction,
  makeOfferAction,
  moveApplicationAction,
  recordAssessmentAction,
  updateApplicationAction,
} from "../actions";
import {
  AssessmentDialog,
  EditApplicationDialog,
  EnrolDialog,
  NoteDialog,
  OfferDialog,
} from "../admission-controls";

export const metadata: Metadata = { title: "Application" };

/** "2026-11-20T09:30" in the school's time zone, for the datetime input. */
function localInput(date: Date | null, timeZone: string): string {
  if (!date) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

export default async function ApplicationPage({
  params,
}: {
  params: Promise<{ school: string; id: string }>;
}) {
  const { school, id } = await params;
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const [app, options] = await Promise.all([getApplication(db(), ctx, id), admissionOptions(db(), ctx)]);
  if (!app) notFound();
  const tz = ctx.tenant.timezone;
  const money = (minor: number) => formatMoney(minor, ctx.tenant.currencyCode);
  const levelClasses = options.classes
    .filter((c) => c.levelId === app.level.id)
    .map((c) => ({ id: c.id, name: c.name }));
  const pendingFees = options.admissionFees.map((f) => `${f.description} ${money(f.amountPesewas)}`);
  const offerFees = app.offer.fees.map((f) => `${f.description} ${money(f.amountPesewas)}`);
  const move = (to: "applied" | "declined" | "withdrawn") =>
    moveApplicationAction.bind(null, slug, app.id, to);
  const s = app.status;

  return (
    <div className="space-y-10">
      <div>
        <Link
          href={schoolPath(slug, "admissions") as Route}
          className="-ml-2 inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm text-ink-2 hover:text-ink"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Applications
        </Link>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm text-ink-3">
              {app.reference} · {APPLICATION_SOURCE_LABELS[app.source]}
            </p>
            <h2 className="font-display text-xl font-medium tracking-tight text-ink">{app.child.name}</h2>
            <p className="mt-1">
              <StatusText tone={s === "enrolled" ? "positive" : s === "declined" ? "critical" : "neutral"}>
                {APPLICATION_STATUS_LABELS[s]}
              </StatusText>
            </p>
          </div>
          {app.canManage && (
            <div className="flex flex-wrap gap-2">
              {s === "inquiry" && (
                <NoteDialog
                  action={move("applied")}
                  trigger="Mark as applied"
                  title="The family has applied"
                  description="The inquiry becomes an application."
                  submitLabel="Mark as applied"
                  required={false}
                />
              )}
              {(s === "applied" || s === "assessment") && (
                <AssessmentDialog
                  action={recordAssessmentAction.bind(null, slug, app.id)}
                  at={localInput(app.assessment.at, tz)}
                  note={app.assessment.note ?? ""}
                  rescheduling={s === "assessment"}
                />
              )}
              {(s === "applied" || s === "assessment") && (
                <OfferDialog
                  action={makeOfferAction.bind(null, slug, app.id)}
                  terms={options.terms}
                  classes={levelClasses}
                  entryTermId={app.entryTerm?.id ?? ""}
                  fees={pendingFees}
                />
              )}
              {s === "offered" && (
                <>
                  <a
                    href={`${schoolPath(slug, `admissions/${app.id}/offer-letter`)}`}
                    className={buttonStyles("secondary")}
                  >
                    <FileText aria-hidden="true" className="size-4" />
                    Offer letter (PDF)
                  </a>
                  <EnrolDialog
                    action={enrolAction.bind(null, slug, app.id)}
                    classes={levelClasses}
                    classId={app.offer.classId ?? ""}
                    fees={offerFees}
                  />
                </>
              )}
              <NoteDialog
                action={move("withdrawn")}
                trigger="Family withdrew"
                title="The family withdrew"
                description="The application closes. A family that comes back starts a new one."
                submitLabel="Close the application"
                required
                danger
              />
              <NoteDialog
                action={move("declined")}
                trigger="Decline"
                title="Decline the application"
                description="The application closes. The reason is kept with it."
                submitLabel="Decline"
                required
                danger
              />
            </div>
          )}
        </div>
      </div>

      {app.erased && (
        <p className="text-base text-ink-3">
          The personal details were removed 12 months after the application closed. What remains is kept for
          the admissions report.
        </p>
      )}

      {app.student && (
        <p className="text-base text-ink-2">
          Enrolled as{" "}
          <Link
            href={schoolPath(slug, `students/${app.student.id}`) as Route}
            className="font-medium text-accent hover:underline"
          >
            {app.student.admissionNumber}
          </Link>
          .
        </p>
      )}

      <div className="grid gap-10 lg:grid-cols-2">
        <Section
          title="Details"
          aside={
            app.canManage &&
            !app.erased && (
              <EditApplicationDialog
                action={updateApplicationAction.bind(null, slug, app.id)}
                levels={options.levels}
                terms={options.terms}
                values={{
                  childFirstName: app.child.firstName,
                  childOtherNames: app.child.otherNames,
                  childLastName: app.child.lastName,
                  sex: app.child.sex,
                  dateOfBirth: app.child.dateOfBirth,
                  previousSchool: app.child.previousSchool,
                  levelId: app.level.id,
                  entryTermId: app.entryTerm?.id,
                  guardianName: app.guardian.name,
                  guardianPhone: app.guardian.phone ? formatPhone(app.guardian.phone) : "",
                  guardianEmail: app.guardian.email,
                  guardianRelationship: app.guardian.relationship,
                  notes: app.notes,
                }}
              />
            )
          }
        >
          <DescriptionList
            items={[
              { term: "Level", detail: app.level.name },
              {
                term: "Starting",
                detail: app.entryTerm
                  ? `${app.entryTerm.name} (${formatCalendarDate(app.entryTerm.startsOn)})`
                  : "Not decided",
              },
              {
                term: "Sex",
                detail: app.child.sex ? (app.child.sex === "female" ? "Female" : "Male") : "Not recorded",
              },
              {
                term: "Date of birth",
                detail: app.child.dateOfBirth ? formatCalendarDate(app.child.dateOfBirth) : "—",
              },
              { term: "Previous school", detail: app.child.previousSchool ?? "—" },
              { term: "Parent or guardian", detail: app.guardian.name ?? "—" },
              { term: "Phone", detail: app.guardian.phone ? formatPhone(app.guardian.phone) : "—" },
              { term: "Email", detail: app.guardian.email ?? "—" },
              { term: "Notes", detail: app.notes ?? "—" },
              ...(app.assessment.at
                ? [
                    {
                      term: "Assessment",
                      detail: `${formatDateTime(app.assessment.at, tz)}${app.assessment.note ? `. ${app.assessment.note}` : ""}`,
                    },
                  ]
                : []),
              ...(app.offer.at
                ? [
                    {
                      term: "Offer",
                      detail: `${formatDateTime(app.offer.at, tz)}${app.offer.className ? `, ${app.offer.className}` : ""}${app.offer.respondBy ? `; reply by ${formatCalendarDate(app.offer.respondBy)}` : ""}`,
                    },
                    { term: "Admission fees", detail: offerFees.length ? offerFees.join(" · ") : "None" },
                  ]
                : []),
            ]}
          />
        </Section>

        <Section title="History">
          <ol className="space-y-3 border-l border-line pl-4">
            {app.events.map((e, i) => (
              <li key={i}>
                <p className="text-base text-ink">
                  {APPLICATION_STATUS_LABELS[e.to]}
                  <span className="text-sm text-ink-3"> · {formatDateTime(e.at, tz)}</span>
                </p>
                <p className="text-sm text-ink-3">
                  {e.by ?? (app.source === "online" && i === 0 ? "Online form" : "EduBridge")}
                  {e.note ? `: ${e.note}` : ""}
                </p>
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </div>
  );
}
