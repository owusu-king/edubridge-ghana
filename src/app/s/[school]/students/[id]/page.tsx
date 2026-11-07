import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge, StatusText } from "@/components/ui/badge";
import { DescriptionList, PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listGuardians, RELATIONSHIP_LABELS } from "@/server/students/guardians";
import { listStudentMessages } from "@/server/messages/history";
import { listPriorRecords } from "@/server/passport/records";
import { getStudentAccount } from "@/server/fees/ledger";
import { listConcessions } from "@/server/fees/concessions";
import { getPaymentPlan } from "@/server/fees/payment-plans";
import { hasOpeningBalance, suggestedAsOf } from "@/server/fees/opening-balances";
import { listFeeItems } from "@/server/fees/structure";
import { listMobileMoneyRequests, mobileMoneySetup } from "@/server/mobile-money/requests";
import { getReminderState } from "@/server/fees/reminders";
import { feeReminderMessage, feeReminderSms, whatsappLink } from "@/lib/fee-messages";
import { balanceLinkUrl } from "@/server/notifications/templates";
import { getStudent, listClassOptions } from "@/server/students/service";
import { formatCalendarDate, formatDateTime, todayIn } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { assignClassAction, setStudentStatusAction, updateStudentAction } from "../actions";
import { ChangeClassDialog, EditStudentDialog, StatusDialog } from "../student-forms";
import {
  addGuardianAction,
  makePrimaryAction,
  setParentAccessAction,
  unlinkGuardianAction,
  updateGuardianAction,
} from "./guardian-actions";
import {
  AddGuardianDialog,
  EditGuardianDialog,
  MakePrimaryButton,
  ParentAccessButton,
  RemoveGuardianButton,
} from "./guardian-controls";
import { FeeAccount } from "./fee-account";

import { LearnerRecords } from "./learner-records";

export const metadata: Metadata = { title: "Student" };

const STATUS = {
  active: <StatusText tone="positive">Active</StatusText>,
  withdrawn: <StatusText tone="neutral">Withdrawn</StatusText>,
  graduated: <StatusText tone="neutral">Graduated</StatusText>,
};

const MESSAGE_KINDS = {
  fee_reminder: "Fee reminder",
  payment_receipt: "Payment receipt",
  absence_alert: "Absence alert",
} as const;

export default async function StudentPage({ params }: { params: Promise<{ school: string; id: string }> }) {
  const { school, id } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "students.view")) notFound();
  const canSeeFees = allowed(ctx, "fees.view");
  const [student, guardianLinks, account] = await Promise.all([
    getStudent(db(), ctx, id),
    listGuardians(db(), ctx, id),
    canSeeFees ? getStudentAccount(db(), ctx, id) : Promise.resolve(null),
  ]);
  if (!student) notFound();
  const [concessions, feeItemOptions, plan, mobileMoneyRequests, reminderState] = account
    ? await Promise.all([
        listConcessions(db(), ctx, id),
        allowed(ctx, "fees.manage")
          ? listFeeItems(db(), ctx).then((items) =>
              items.filter((i) => i.status === "active").map((i) => ({ value: i.id, label: i.name })),
            )
          : Promise.resolve([]),
        getPaymentPlan(db(), ctx, id),
        listMobileMoneyRequests(db(), ctx, id),
        getReminderState(db(), ctx, id),
      ])
    : [[], [], null, [], null];
  // Offer an opening balance only to finance staff, and only while the student has none.
  const openingAsOf =
    account && allowed(ctx, "fees.manage") && !(await hasOpeningBalance(db(), ctx, id))
      ? await suggestedAsOf(db(), ctx)
      : undefined;
  const messages = allowed(ctx, "students.view_all") ? await listStudentMessages(db(), ctx, id) : null;
  const prior = allowed(ctx, "students.view_all") ? await listPriorRecords(db(), ctx, id) : [];
  const links = guardianLinks ?? [];
  const slug = ctx.tenant.slug;
  const canManage = allowed(ctx, "students.manage");
  const canManageParentAccess = allowed(ctx, "parents.access.manage");
  const classes = canManage
    ? (await listClassOptions(db(), ctx)).map((c) => ({ id: c.id, name: c.name }))
    : [];

  return (
    <div className="space-y-10">
      <div className="space-y-4">
        <Link
          href={schoolPath(slug, "students")}
          className="inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Students
        </Link>
        <PageHeader
          title={student.fullName}
          description={
            <span className="inline-flex flex-wrap items-center gap-3">
              <span className="font-mono text-sm">{student.admissionNumber}</span>
              {STATUS[student.status]}
            </span>
          }
          actions={
            canManage && (
              <>
                <EditStudentDialog
                  action={updateStudentAction.bind(null, slug, student.id)}
                  defaults={student}
                />
                <StatusDialog
                  action={setStudentStatusAction.bind(
                    null,
                    slug,
                    student.id,
                    student.status === "active" ? "withdrawn" : "active",
                  )}
                  status={student.status}
                  name={student.fullName}
                />
              </>
            )
          }
        />
      </div>

      <div className="grid gap-10 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0 space-y-10">
          <Section
            title="Class"
            aside={
              canManage &&
              student.status === "active" &&
              classes.length > 0 && (
                <ChangeClassDialog
                  action={assignClassAction.bind(null, slug, student.id)}
                  classes={classes}
                  currentClassId={student.currentClass?.id}
                />
              )
            }
          >
            <p className="text-base text-ink">
              {student.currentClass?.name ?? <span className="text-ink-3">Not in a class this term</span>}
            </p>
            {student.history.length > 0 && (
              <TableFrame>
                <Table>
                  <caption className="sr-only">Class history</caption>
                  <THead>
                    <tr>
                      <TH>Term</TH>
                      <TH>Class</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {student.history.map((h) => (
                      <TR key={`${h.yearName}-${h.termName}`}>
                        <TD>
                          {h.termName}, {h.yearName}
                        </TD>
                        <TD className="text-ink">{h.className}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableFrame>
            )}
          </Section>
          {account && (
            <FeeAccount
              slug={slug}
              account={account}
              canManage={allowed(ctx, "fees.manage")}
              canRecordPayment={allowed(ctx, "payments.record")}
              payerName={links.find((g) => g.isPrimary)?.fullName}
              today={todayIn(ctx.tenant.timezone)}
              openingAsOf={openingAsOf}
              concessions={concessions}
              feeItems={feeItemOptions}
              plan={plan}
              outreach={{
                statementHref: schoolPath(slug, `students/${student.id}/statement`),
                canRemind: allowed(ctx, "fees.remind"),
                reminder:
                  account.balancePesewas > 0 && reminderState?.contact?.phone
                    ? {
                        contactName: reminderState.contact.name,
                        phone: formatPhone(reminderState.contact.phone),
                        remindedToday: reminderState.remindedToday,
                        lastRemindedOn: reminderState.lastRemindedOn,
                        smsPreview: feeReminderSms({
                          schoolName: ctx.tenant.name,
                          studentFirstName: student.firstName,
                          balancePesewas: account.balancePesewas,
                          link: balanceLinkUrl("…"),
                        }),
                        whatsappHref: whatsappLink(
                          reminderState.contact.phone,
                          feeReminderMessage({
                            schoolName: ctx.tenant.name,
                            studentName: student.fullName,
                            balancePesewas: account.balancePesewas,
                          }),
                        ),
                      }
                    : null,
              }}
              mobileMoney={{
                ...mobileMoneySetup(ctx),
                requests: mobileMoneyRequests,
                // Primary contact first; the dialog suggests the first number.
                phones: [...links]
                  .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
                  .flatMap((g) => (g.phone ? [{ name: g.fullName, phone: formatPhone(g.phone) }] : [])),
                timeZone: ctx.tenant.timezone,
              }}
            />
          )}
        </div>
        <div className="space-y-10">
          <Section title="Details">
            <DescriptionList
              stacked
              items={[
                { term: "Sex", detail: student.sex === "female" ? "Female" : "Male" },
                {
                  term: "Date of birth",
                  detail: student.dateOfBirth ? (
                    formatCalendarDate(student.dateOfBirth)
                  ) : (
                    <span className="text-ink-3">Not recorded</span>
                  ),
                },
                {
                  term: "Admitted",
                  detail: student.admittedOn ? (
                    formatCalendarDate(student.admittedOn)
                  ) : (
                    <span className="text-ink-3">Not recorded</span>
                  ),
                },
              ]}
            />
          </Section>
          <Section
            title="Guardians"
            aside={
              canManage &&
              links.length < 4 && (
                <AddGuardianDialog action={addGuardianAction.bind(null, slug, student.id)} />
              )
            }
          >
            {links.length === 0 ? (
              <p className="text-base text-ink-3">
                No guardian recorded. Add one so the school can reach the family.
              </p>
            ) : (
              <ul className="divide-y divide-line rounded-lg border border-line bg-surface shadow-raised">
                {links.map((g) => (
                  <li key={g.guardianId} className="space-y-1.5 px-4 py-3.5">
                    <p className="flex flex-wrap items-center gap-2 text-base font-medium text-ink">
                      {g.fullName}
                      {g.isPrimary && <Badge tone="accent">Primary contact</Badge>}
                      {g.portalBlockedAt && <Badge tone="critical">Blocked from parent view</Badge>}
                    </p>
                    <p className="text-sm text-ink-3">{RELATIONSHIP_LABELS[g.relationship]}</p>
                    {g.phone && (
                      <a href={`tel:${g.phone}`} className="block text-sm text-accent hover:underline">
                        {formatPhone(g.phone)}
                      </a>
                    )}
                    {g.email && <p className="text-sm break-all text-ink-2">{g.email}</p>}
                    {g.otherStudents.length > 0 && (
                      <p className="text-sm text-ink-2">
                        Also guardian of{" "}
                        {g.otherStudents.map((o, i) => (
                          <span key={o.id}>
                            {i > 0 && ", "}
                            <Link
                              href={schoolPath(slug, `students/${o.id}`)}
                              className="text-accent hover:underline"
                            >
                              {o.name}
                            </Link>
                            {o.className && ` (${o.className})`}
                          </span>
                        ))}
                      </p>
                    )}
                    {(canManage || (canManageParentAccess && g.phone)) && (
                      <div className="-ml-3 flex flex-wrap gap-1 pt-1">
                        {canManage && (
                          <>
                            <EditGuardianDialog
                              action={updateGuardianAction.bind(null, slug, g.guardianId)}
                              guardian={g}
                            />
                            {!g.isPrimary && (
                              <MakePrimaryButton
                                action={makePrimaryAction.bind(null, slug, student.id, g.guardianId)}
                                name={g.fullName}
                              />
                            )}
                            <RemoveGuardianButton
                              action={unlinkGuardianAction.bind(null, slug, student.id, g.guardianId)}
                              name={g.fullName}
                            />
                          </>
                        )}
                        {canManageParentAccess && g.phone && (
                          <ParentAccessButton
                            action={setParentAccessAction.bind(null, slug, g.guardianId, !g.portalBlockedAt)}
                            name={g.fullName}
                            blocked={g.portalBlockedAt !== null}
                          />
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          {messages && (
            <Section title="Messages to the family" description="SMS sent about this student, newest first.">
              {messages.length === 0 ? (
                <p className="text-sm text-ink-3">None yet.</p>
              ) : (
                <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
                  {messages.map((m, i) => (
                    <li key={i} className="flex items-start justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-base text-ink">{MESSAGE_KINDS[m.kind]}</p>
                        <p className="text-sm text-ink-3">
                          {formatPhone(m.recipient)} · {formatDateTime(m.queuedAt, ctx.tenant.timezone)}
                        </p>
                      </div>
                      <StatusText
                        tone={m.state === "sent" ? "positive" : m.state === "failed" ? "critical" : "neutral"}
                      >
                        {m.state === "sent"
                          ? "Delivered"
                          : m.state === "failed"
                            ? "Not delivered"
                            : "Sending"}
                      </StatusText>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}
          <LearnerRecords
            prior={prior}
            downloadUrl={allowed(ctx, "transfers.manage") ? `/s/${slug}/students/${id}/record` : null}
            timezone={ctx.tenant.timezone}
          />
        </div>
      </div>
    </div>
  );
}
