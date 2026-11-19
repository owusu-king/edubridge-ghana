import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { UserCheck } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { StatusText } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { EmptyState, PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getPickupDay, listPickupClasses, listRefusalsToday } from "@/server/visitors/pickup";
import { formatCalendarDate, formatTime } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { refuseAction, releaseAction } from "./actions";
import { RefuseDialog, ReleaseDialog } from "./pickup-controls";

export const metadata: Metadata = { title: "Pickup" };

/** The day's pickup list for a class (VIS-02d): who has gone home, with whom, and who is still here. */
export default async function PickupPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ class?: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "pickup.view")) notFound();
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const record = allowed(ctx, "pickup.record");
  const base = schoolPath(slug, "pickup");
  const [{ classes, ownClassId }, refusals] = await Promise.all([
    listPickupClasses(db(), ctx),
    listRefusalsToday(db(), ctx),
  ]);
  const asked = (await searchParams).class;
  const classId = classes.some((c) => c.id === asked) ? asked! : (ownClassId ?? classes[0]?.id ?? null);
  const day = classId ? await getPickupDay(db(), ctx, classId) : null;
  const collected = day?.students.filter((s) => s.latest?.outcome === "released").length ?? 0;

  return (
    <div className="space-y-10">
      <PageHeader
        title="Pickup"
        description="Release each child only to someone on their list. If anyone else comes, keep the child at school and record a refusal."
      />
      {ctx.modules.visitors_pickup?.state === "read_only" && (
        <Alert tone="info">
          Visitors and pickup has ended for this school. The records can be viewed and exported, but nothing
          new can be recorded. Ask EduBridge to add it again to carry on.
        </Alert>
      )}

      {refusals.length > 0 && (
        <Section title="Refused today" description="Someone came who may not collect the child.">
          <ul className="divide-y divide-line border-y border-line">
            {refusals.map((r) => (
              <li key={r.id} className="py-2.5 text-base text-ink">
                <Link href={`${base}/${r.studentId}` as Route} className="font-medium hover:underline">
                  {r.student}
                </Link>
                {r.className ? ` (${r.className})` : ""}: {r.personName}
                {r.relationship ? `, ${r.relationship}` : ""}
                <span className="block text-sm text-ink-3">
                  {formatTime(r.recordedAt, tz)} · {r.reason} · recorded by {r.recordedBy}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {classes.length === 0 || !day ? (
        <EmptyState
          icon={<UserCheck />}
          title="No classes"
          description="Classes at your campuses appear here once the school has set them up for this term."
        />
      ) : (
        <Section
          title={`${day.className} · ${formatCalendarDate(day.date)}`}
          description={`${collected} of ${day.students.length} collected.`}
          aside={
            <form method="get" className="flex items-end gap-2" aria-label="Choose class">
              <label htmlFor="pickup-class" className="sr-only">
                Class
              </label>
              <Select id="pickup-class" name="class" defaultValue={classId!} className="w-44">
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
              <button type="submit" className={buttonStyles("secondary")}>
                Show
              </button>
            </form>
          }
        >
          {day.students.length === 0 ? (
            <p className="text-base text-ink-3">No children in this class this term.</p>
          ) : (
            <TableFrame>
              <Table>
                <caption className="sr-only">Pickup, {day.className}</caption>
                <THead>
                  <tr>
                    <TH>Child</TH>
                    <TH>Today</TH>
                    {record && (
                      <TH>
                        <span className="sr-only">Release or refuse</span>
                      </TH>
                    )}
                  </tr>
                </THead>
                <TBody>
                  {day.students.map((s) => (
                    <TR key={s.id}>
                      <TD>
                        <Link
                          href={`${base}/${s.id}` as Route}
                          className="font-medium text-ink hover:underline"
                        >
                          {s.name}
                        </Link>
                        <span className="block text-sm text-ink-3">
                          {s.collectors.length
                            ? s.collectors.map((c) => c.name).join(", ")
                            : "Nobody on the list"}
                        </span>
                      </TD>
                      <TD>
                        {!s.latest ? (
                          <span className="text-ink-3">Not collected</span>
                        ) : s.latest.outcome === "released" ? (
                          <>
                            <StatusText tone="positive">Collected</StatusText>
                            <span className="block text-sm text-ink-3">
                              {formatTime(s.latest.recordedAt, tz)} by {s.latest.personName}
                            </span>
                          </>
                        ) : (
                          <>
                            <StatusText tone="critical">Refused</StatusText>
                            <span className="block text-sm text-ink-3">
                              {formatTime(s.latest.recordedAt, tz)} · {s.latest.personName}
                            </span>
                          </>
                        )}
                      </TD>
                      {record && (
                        <TD className="text-right">
                          {s.latest?.outcome !== "released" && (
                            <div className="inline-flex flex-wrap justify-end gap-2">
                              {s.collectors.length > 0 && (
                                <ReleaseDialog
                                  action={releaseAction.bind(null, slug, s.id)}
                                  child={s.name}
                                  collectors={s.collectors.map((c) => ({
                                    key: c.key,
                                    name: c.name,
                                    relationship: c.relationship,
                                    kind: c.kind,
                                    photoUrl: c.hasPhoto ? `${base}/${s.id}/collectors/${c.id}/photo` : null,
                                  }))}
                                />
                              )}
                              <RefuseDialog action={refuseAction.bind(null, slug, s.id)} child={s.name} />
                            </div>
                          )}
                        </TD>
                      )}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
        </Section>
      )}
    </div>
  );
}
