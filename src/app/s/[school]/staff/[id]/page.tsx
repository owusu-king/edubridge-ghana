import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatusText } from "@/components/ui/badge";
import { ActionButton, UploadForm } from "@/components/ui/action-forms";
import { DescriptionList, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { listCampuses } from "@/server/campuses/service";
import { db } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { getStaffLeave, listLeaveTypes } from "@/server/staff/leave";
import { getStaff, listLinkableMembers, listStaffLists } from "@/server/staff/records";
import { formatCalendarDate, formatDateTime, todayIn } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { EMPLOYMENT_EVENT_LABELS, EMPLOYMENT_TYPE_LABELS, LEAVE_STATUS_LABELS } from "@/lib/staff";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import {
  changeEmploymentAction,
  linkStaffMemberAction,
  recordLeaveAction,
  removeStaffDocumentAction,
  updateStaffDetailsAction,
  uploadStaffDocumentAction,
} from "../actions";
import { EditDetailsDialog, EmploymentDialog, LinkMemberDialog, RecordLeaveDialog } from "../staff-controls";

export const metadata: Metadata = { title: "Staff member" };

const LEAVE_TONE = {
  pending: "caution",
  approved: "positive",
  declined: "neutral",
  cancelled: "neutral",
} as const;

export default async function StaffMemberPage({
  params,
}: {
  params: Promise<{ school: string; id: string }>;
}) {
  const { school, id } = await params;
  const { ctx } = await requireTenant(school);
  // Pages render alongside the layout, so each checks access itself too.
  if (!allowed(ctx, "staff.view")) notFound();
  let detail;
  try {
    detail = await getStaff(db(), ctx, id);
  } catch (error) {
    if (error instanceof DomainError) notFound();
    throw error;
  }
  const slug = ctx.tenant.slug;
  const tz = ctx.tenant.timezone;
  const today = todayIn(tz);
  const canManage = allowed(ctx, "staff.manage");
  const canDocs = allowed(ctx, "staff.documents");
  const canRecordLeave = allowed(ctx, "leave.approve");
  const [leave, types, lists, campuses, members] = await Promise.all([
    getStaffLeave(db(), ctx, id),
    listLeaveTypes(db(), ctx),
    canManage ? listStaffLists(db(), ctx) : null,
    canManage ? listCampuses(db(), ctx) : null,
    canManage ? listLinkableMembers(db(), ctx) : null,
  ]);
  const r = detail.record;
  const options = {
    departments: (lists?.departments ?? [])
      .filter((d) => !d.archived)
      .map((d) => ({ value: d.id, label: d.name })),
    positions: (lists?.positions ?? [])
      .filter((p) => !p.archived)
      .map((p) => ({ value: p.id, label: p.name })),
    campuses: (campuses ?? [])
      .filter((c) => c.status === "active" && (ctx.campusIds === null || ctx.campusIds.includes(c.id)))
      .map((c) => ({ value: c.id, label: c.name })),
  };
  const employment = {
    employmentType: r.employmentType,
    departmentId: r.departmentId,
    positionId: r.positionId,
    campusId: r.campusId,
  };
  const memberOptions = [
    ...(detail.account && r.membershipId ? [{ value: r.membershipId, label: detail.account.name }] : []),
    ...(members ?? []).map((m) => ({ value: m.id, label: `${m.name} (${m.email})` })),
  ];
  const activeTypes = types.filter((t) => !t.archived).map((t) => ({ value: t.id, label: t.name }));
  const docsBase = `${schoolPath(slug, "staff")}/${id}/documents`;

  return (
    <div className="space-y-10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link href={schoolPath(slug, "staff")} className="text-sm font-medium text-accent hover:underline">
            All staff
          </Link>
          <h2 className="mt-2 text-xl font-semibold text-ink">{detail.name}</h2>
          <p className="text-base text-ink-3">
            {r.staffNumber}
            {detail.position ? ` · ${detail.position}` : ""}{" "}
            {r.status === "active" ? (
              <StatusText tone="positive">Working here</StatusText>
            ) : (
              <StatusText tone="neutral">Left on {formatCalendarDate(r.leftOn!)}</StatusText>
            )}
          </p>
        </div>
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <EditDetailsDialog action={updateStaffDetailsAction.bind(null, slug, id)} values={r} />
            {r.status === "active" ? (
              <>
                <EmploymentDialog
                  action={changeEmploymentAction.bind(null, slug, id, "changed")}
                  kind="changed"
                  options={options}
                  values={employment}
                  today={today}
                />
                <EmploymentDialog
                  action={changeEmploymentAction.bind(null, slug, id, "left")}
                  kind="left"
                  options={options}
                  values={employment}
                  today={today}
                />
              </>
            ) : (
              <EmploymentDialog
                action={changeEmploymentAction.bind(null, slug, id, "returned")}
                kind="returned"
                options={options}
                values={employment}
                today={today}
              />
            )}
          </div>
        )}
      </div>

      <div className="grid gap-10 lg:grid-cols-2">
        <Section title="Personal details">
          <DescriptionList
            items={[
              {
                term: "Sex",
                detail: r.sex === "female" ? "Female" : r.sex === "male" ? "Male" : "Not given",
              },
              {
                term: "Date of birth",
                detail: r.dateOfBirth ? formatCalendarDate(r.dateOfBirth) : "Not given",
              },
              { term: "Phone", detail: r.phone ? formatPhone(r.phone) : "Not given" },
              { term: "Email", detail: r.email ?? "Not given" },
              { term: "Address", detail: r.address ?? "Not given" },
              { term: "Qualifications", detail: r.qualifications ?? "Not given" },
              {
                term: "Emergency contact",
                detail: r.emergencyName
                  ? [
                      r.emergencyName,
                      r.emergencyRelationship,
                      r.emergencyPhone ? formatPhone(r.emergencyPhone) : null,
                    ]
                      .filter(Boolean)
                      .join(", ")
                  : "Not given",
              },
            ]}
          />
        </Section>
        <Section
          title="Employment"
          aside={
            canManage && (
              <LinkMemberDialog
                action={linkStaffMemberAction.bind(null, slug, id)}
                members={memberOptions}
                current={r.membershipId}
              />
            )
          }
        >
          <DescriptionList
            items={[
              { term: "Employment", detail: EMPLOYMENT_TYPE_LABELS[r.employmentType] },
              { term: "Position", detail: detail.position ?? "Not set" },
              { term: "Department", detail: detail.department ?? "Not set" },
              ...(detail.campus ? [{ term: "Campus", detail: detail.campus }] : []),
              { term: "Started", detail: formatCalendarDate(r.startedOn) },
              ...(r.leavingReason ? [{ term: "Why they left", detail: r.leavingReason }] : []),
              {
                term: "EduBridge account",
                detail: detail.account ? `${detail.account.name} (${detail.account.email})` : "None",
              },
              ...(detail.teaching.classTeacherOf.length
                ? [{ term: "Class teacher of", detail: detail.teaching.classTeacherOf.join(", ") }]
                : []),
              ...(detail.teaching.subjects.length
                ? [
                    {
                      term: "Teaches",
                      detail: detail.teaching.subjects.map((t) => `${t.subject} (${t.className})`).join(", "),
                    },
                  ]
                : []),
            ]}
          />
        </Section>
      </div>

      <Section
        title={`Leave in ${leave.year}`}
        description="Working days, Monday to Friday, less the school's holidays."
        aside={
          canRecordLeave &&
          r.status === "active" &&
          activeTypes.length > 0 && (
            <RecordLeaveDialog
              action={recordLeaveAction.bind(null, slug, id)}
              types={activeTypes}
              today={today}
            />
          )
        }
      >
        {leave.balances.length === 0 ? (
          <p className="text-base text-ink-3">
            No leave types yet.{" "}
            {canManage && (
              <Link href={schoolPath(slug, "staff/settings")} className="text-accent hover:underline">
                Set them up
              </Link>
            )}
          </p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-3">
            {leave.balances.map((b) => (
              <li key={b.leaveTypeId} className="rounded-lg border border-line px-4 py-3">
                <p className="text-sm text-ink-3">{b.name}</p>
                <p className="tabular text-lg font-semibold text-ink">
                  {b.left === null ? `${b.taken} taken` : `${b.left} of ${b.allowed} left`}
                </p>
              </li>
            ))}
          </ul>
        )}
        {leave.requests.length > 0 && (
          <TableFrame>
            <Table>
              <caption className="sr-only">Leave of {detail.name}</caption>
              <THead>
                <tr>
                  <TH>Leave</TH>
                  <TH>Dates</TH>
                  <TH numeric>Days</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <TBody>
                {leave.requests.map((l) => (
                  <TR key={l.id}>
                    <TD>
                      {l.type}
                      {l.reason && <span className="block text-sm text-ink-3">{l.reason}</span>}
                    </TD>
                    <TD>
                      {formatCalendarDate(l.startsOn)}
                      {l.endsOn !== l.startsOn ? ` to ${formatCalendarDate(l.endsOn)}` : ""}
                    </TD>
                    <TD numeric>{l.days}</TD>
                    <TD>
                      <StatusText tone={LEAVE_TONE[l.status]}>{LEAVE_STATUS_LABELS[l.status]}</StatusText>
                      {l.decisionNote && <span className="block text-sm text-ink-3">{l.decisionNote}</span>}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>

      {canDocs && detail.documents && (
        <Section
          title="Documents"
          description="Contracts, certificates and similar. Private: every download is recorded in the audit log."
        >
          {detail.documents.length === 0 ? (
            <p className="text-base text-ink-3">No documents yet.</p>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {detail.documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <a
                      href={`${docsBase}/${d.id}`}
                      className="font-medium text-accent hover:underline"
                      aria-label={`Download ${d.filename}`}
                    >
                      {d.filename}
                    </a>
                    <p className="text-sm text-ink-3">
                      Added by {d.uploadedBy}, {formatDateTime(d.uploadedAt, tz)}
                    </p>
                  </div>
                  {canManage && (
                    <ActionButton
                      action={removeStaffDocumentAction.bind(null, slug, id, d.id)}
                      label="Remove"
                      ariaLabel={`Remove ${d.filename}`}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <UploadForm
              action={uploadStaffDocumentAction.bind(null, slug, id)}
              label="Add a document"
              accept="application/pdf,image/png,image/jpeg"
              submitLabel="Upload"
            />
          )}
        </Section>
      )}

      <Section
        title="Employment history"
        description="Every change, with the date it took effect. Never edited."
      >
        <ol className="divide-y divide-line border-y border-line">
          {detail.history.map((h, i) => (
            <li key={i} className="py-3">
              <p className="text-base text-ink">
                {EMPLOYMENT_EVENT_LABELS[h.kind]} on {formatCalendarDate(h.effectiveOn)}
                {h.kind !== "left" && (
                  <span className="text-ink-2">
                    {" "}
                    · {EMPLOYMENT_TYPE_LABELS[h.employmentType]}
                    {h.position ? `, ${h.position}` : ""}
                    {h.department ? `, ${h.department}` : ""}
                    {h.campus ? `, ${h.campus}` : ""}
                  </span>
                )}
              </p>
              {h.note && <p className="text-sm text-ink-2">{h.note}</p>}
              <p className="text-sm text-ink-3">
                Recorded by {h.recordedBy}, {formatDateTime(h.recordedAt, tz)}
              </p>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}
