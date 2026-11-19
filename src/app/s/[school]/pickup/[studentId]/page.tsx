import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusText } from "@/components/ui/badge";
import { PageHeader, Section } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { getStudentPickup } from "@/server/visitors/pickup";
import { formatCalendarDate, formatDateTime, todayIn } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { addCollectorAction, cancelPickupAction, endCollectorAction } from "../actions";
import { AddCollectorDialog, ReasonDialog } from "../pickup-controls";

export const metadata: Metadata = { title: "Pickup" };

/** Who may collect a child (VIS-02a) and every release and refusal (VIS-02d). */
export default async function StudentPickupPage({
  params,
}: {
  params: Promise<{ school: string; studentId: string }>;
}) {
  const { school, studentId } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "pickup.view")) notFound();
  const data = await getStudentPickup(db(), ctx, studentId).catch((error: unknown) => {
    if (error instanceof DomainError) notFound();
    throw error;
  });
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const base = schoolPath(slug, "pickup");
  const manage = allowed(ctx, "pickup.manage");
  const record = allowed(ctx, "pickup.record");
  const { student } = data;
  const allowedGuardians = data.guardians.filter((g) => g.allowed);
  const otherGuardians = data.guardians.filter((g) => !g.allowed);
  const current = data.collectors.filter((c) => !c.endedAt);
  const ended = data.collectors.filter((c) => c.endedAt);
  const nobody = allowedGuardians.length === 0 && !current.some((c) => c.allowed);

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Pickup"
        title={student.name}
        description={[
          student.className ?? "Not in a class this term",
          `Admission number ${student.admissionNumber}`,
        ].join(" · ")}
        actions={
          <Link
            href={(student.classId ? `${base}?class=${student.classId}` : base) as Route}
            className="text-base text-ink-2 hover:text-ink hover:underline"
          >
            Back to the class
          </Link>
        }
      />

      <Section
        title="Who may collect this child"
        description="Guardians are allowed on the student record; others are named here by the office."
        aside={
          manage ? (
            <AddCollectorDialog
              action={addCollectorAction.bind(null, slug, student.id)}
              today={todayIn(tz)}
            />
          ) : undefined
        }
      >
        {nobody && (
          <p className="text-base text-critical">
            Nobody may collect this child at the moment. Do not release them; ask the office.
          </p>
        )}
        <ul className="divide-y divide-line border-y border-line">
          {allowedGuardians.map((g) => (
            <li key={g.id} className="flex items-center gap-3 py-3">
              <span className="text-base text-ink">
                {g.name}
                <span className="block text-sm text-ink-3">
                  {g.relationship} · guardian{g.phone ? ` · ${formatPhone(g.phone)}` : ""}
                </span>
              </span>
            </li>
          ))}
          {current.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span className="flex items-center gap-3">
                {c.hasPhoto && (
                  // eslint-disable-next-line @next/next/no-img-element -- private, access-checked route
                  <img
                    src={`${base}/${student.id}/collectors/${c.id}/photo`}
                    alt={`Photo of ${c.fullName}`}
                    className="size-14 shrink-0 rounded-md border border-line object-cover"
                  />
                )}
                <span className="text-base text-ink">
                  {c.fullName}
                  <span className="block text-sm text-ink-3">
                    {[
                      c.relationship,
                      c.phone && formatPhone(c.phone),
                      c.validUntil &&
                        (c.allowed
                          ? `until ${formatCalendarDate(c.validUntil)}`
                          : `last day was ${formatCalendarDate(c.validUntil)}`),
                      c.note,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {!c.allowed && <StatusText tone="caution">No longer allowed</StatusText>}
                </span>
              </span>
              {manage && (
                <ReasonDialog
                  action={endCollectorAction.bind(null, slug, student.id, c.id)}
                  trigger="End"
                  triggerLabel={`End ${c.fullName}`}
                  title={`End ${c.fullName}`}
                  description="They will no longer be able to collect this child. They stay on record."
                  submitLabel="End"
                  label="Why"
                />
              )}
            </li>
          ))}
          {allowedGuardians.length === 0 && current.length === 0 && (
            <li className="py-3 text-base text-ink-3">Nobody yet.</li>
          )}
        </ul>
        {otherGuardians.length > 0 && (
          <p className="text-sm text-ink-3">
            Not allowed to collect: {otherGuardians.map((g) => `${g.name} (${g.relationship})`).join(", ")}.
            {allowed(ctx, "students.manage") && (
              <>
                {" "}
                <Link
                  href={schoolPath(slug, `students/${student.id}`)}
                  className="text-ink-2 underline hover:text-ink"
                >
                  Change on the student record
                </Link>
              </>
            )}
          </p>
        )}
        {ended.length > 0 && (
          <p className="text-sm text-ink-3">
            Ended: {ended.map((c) => `${c.fullName} (${c.relationship}; ${c.endReason})`).join(", ")}.
          </p>
        )}
      </Section>

      <Section
        title="History"
        description="Every release and refusal. Records made by mistake are cancelled, not removed."
      >
        {data.history.length === 0 ? (
          <p className="text-base text-ink-3">Nothing recorded yet.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {data.history.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span className={r.cancelledAt ? "text-base text-ink-3 line-through" : "text-base text-ink"}>
                  {r.outcome === "released" ? "Collected by " : "Refused: "}
                  {r.personName}
                  {r.relationship ? ` (${r.relationship})` : ""}
                  <span className="block text-sm text-ink-3 no-underline">
                    {formatDateTime(r.recordedAt, tz)} · recorded by {r.recordedBy}
                    {r.reason ? ` · ${r.reason}` : ""}
                    {r.note ? ` · ${r.note}` : ""}
                  </span>
                </span>
                {r.cancelledAt ? (
                  <span className="text-sm text-ink-3">Cancelled: {r.cancelReason}</span>
                ) : (
                  record && (
                    <ReasonDialog
                      action={cancelPickupAction.bind(null, slug, student.id, r.id)}
                      trigger="Cancel"
                      triggerLabel={`Cancel the record of ${formatDateTime(r.recordedAt, tz)}`}
                      title="Cancel this record"
                      description="Only for a record made by mistake. It stays in the history, marked cancelled."
                      submitLabel="Cancel record"
                      label="Why"
                    />
                  )
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
