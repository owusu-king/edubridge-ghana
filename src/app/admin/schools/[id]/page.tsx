import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, StatusText } from "@/components/ui/badge";
import { DescriptionList, PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { db } from "@/server/db/client";
import { getSchool } from "@/server/platform/service";
import { getSupportStatusForPlatform } from "@/server/support/access";
import { requirePlatformAdmin } from "@/web/auth";
import { InvoiceState, SubscriptionBadge, UsageTable } from "@/components/billing/billing-views";
import { getPlatformSettings } from "@/server/billing/settings";
import { getSchoolBillingForPlatform, smsCharge } from "@/server/billing/subscriptions";
import { addDays } from "@/lib/attendance";
import { countryName, formatCalendarDate, formatDate, formatDateTime, todayIn } from "@/lib/format";
import { formatCedis, pesewasToInput } from "@/lib/money";
import { monthLabel } from "@/lib/plan";
import {
  issueInvoiceAction,
  markInvoicePaidAction,
  reissueInvitationAction,
  setSchoolStatusAction,
  updateEntitlementsAction,
  updateSubscriptionAction,
  voidInvoiceAction,
} from "../../actions";
import {
  EntitlementsForm,
  InvoiceActions,
  IssueInvoiceDialog,
  SubscriptionForm,
  type InvoiceSuggestion,
} from "./billing-controls";
import { ReissueInvitationForm, StatusControl } from "./school-controls";

export const metadata: Metadata = { title: "School" };

const INVITE_TONE = {
  pending: "accent",
  accepted: "positive",
  revoked: "neutral",
  expired: "neutral",
} as const;

export default async function SchoolAdminPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePlatformAdmin();
  const [school, billing, platform] = await Promise.all([
    getSchool(db(), user.id, id),
    getSchoolBillingForPlatform(db(), user.id, id),
    getPlatformSettings(db(), user.id),
  ]);
  if (!school || !billing) notFound();
  const support = await getSupportStatusForPlatform(db(), user.id, school.id);
  const tz = school.timezone;
  const today = todayIn(tz);
  const { plan } = billing;
  const lastMonth = billing.usage[1];
  const monthEnd = addDays(`${today.slice(0, 7)}-01`, 40).slice(0, 7);
  const suggestion: InvoiceSuggestion = {
    periodStartsOn: `${today.slice(0, 7)}-01`,
    periodEndsOn: addDays(`${monthEnd}-01`, -1),
    dueOn: addDays(today, 14),
    lines: [
      ...(plan.pricePesewas
        ? [
            {
              description: `${plan.planName} plan`,
              quantity: "1",
              unitPrice: pesewasToInput(plan.pricePesewas),
            },
          ]
        : []),
      ...(lastMonth && lastMonth.billable > 0
        ? [
            Number.isInteger(lastMonth.billable)
              ? {
                  description: `SMS, ${monthLabel(lastMonth.month)}`,
                  quantity: String(lastMonth.billable),
                  unitPrice: pesewasToInput(plan.smsPricePesewas),
                }
              : {
                  // Shares of shared sign-in codes make the count fractional: one line for the month's charge.
                  description: `SMS, ${monthLabel(lastMonth.month)} (${lastMonth.billable} SMS incl. shared codes)`,
                  quantity: "1",
                  unitPrice: pesewasToInput(smsCharge(plan.smsPricePesewas, lastMonth.billable)),
                },
          ]
        : []),
    ],
  };
  const lastOwnerInvite = school.invitations.find((i) => i.roles.includes("owner"));

  return (
    <div className="space-y-10">
      <PageHeader
        eyebrow="Schools"
        title={school.name}
        description={
          <span className="inline-flex items-center gap-3">
            <span className="font-mono text-sm">/s/{school.slug}</span>
            {school.status === "active" ? (
              <StatusText tone="positive">Active</StatusText>
            ) : (
              <StatusText tone="caution">Suspended</StatusText>
            )}
            {school.isDemo && <Badge tone="caution">Demo, made-up data</Badge>}
          </span>
        }
        actions={
          <Link href={"/admin" as Route} className="text-sm font-medium text-accent hover:underline">
            All schools
          </Link>
        }
      />

      <div className="grid gap-10 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-10">
          <Section
            title="Plan"
            description={`${school.activeCampuses} active ${school.activeCampuses === 1 ? "campus" : "campuses"} in use.`}
          >
            <EntitlementsForm
              action={updateEntitlementsAction.bind(null, school.id)}
              defaults={{
                planName: plan.planName,
                maxCampuses: plan.maxCampuses,
                maxStudents: plan.maxStudents,
                maxSmsPerMonth: plan.maxSmsPerMonth,
                features: plan.features,
              }}
            />
          </Section>

          <Section
            title="Subscription"
            description={`${plan.activeStudents} active students. Billing is manual: record what was agreed and paid.`}
            aside={
              <SubscriptionBadge
                status={plan.status}
                trialEndsOn={plan.trialEndsOn}
                paidUntil={plan.paidUntil}
              />
            }
          >
            <SubscriptionForm
              action={updateSubscriptionAction.bind(null, school.id)}
              defaults={{
                status: plan.status,
                billingPeriod: plan.billingPeriod,
                trialEndsOn: plan.trialEndsOn,
                paidUntil: plan.paidUntil,
                price: pesewasToInput(plan.pricePesewas),
                smsPrice: pesewasToInput(plan.ownSmsPricePesewas),
                platformSmsPrice: pesewasToInput(platform.smsPricePesewas),
                settlementAccount: plan.settlementAccount ?? "",
                notes: plan.notes,
              }}
            />
          </Section>

          <Section
            title="SMS charged to the school"
            description="The last six months, in the school's time zone."
          >
            <UsageTable usage={billing.usage} />
          </Section>

          <Section
            title="Invoices"
            description="EduBridge's invoices to this school. The school sees them under Settings, Plan."
            aside={
              <IssueInvoiceDialog action={issueInvoiceAction.bind(null, school.id)} suggestion={suggestion} />
            }
          >
            {billing.invoices.length === 0 ? (
              <p className="text-base text-ink-3">No invoices yet.</p>
            ) : (
              <TableFrame>
                <Table>
                  <caption className="sr-only">Invoices to {school.name}</caption>
                  <THead>
                    <tr>
                      <TH>Invoice</TH>
                      <TH className="hidden md:table-cell">Period</TH>
                      <TH className="text-right">Amount</TH>
                      <TH>Status</TH>
                      <TH>
                        <span className="sr-only">Actions</span>
                      </TH>
                    </tr>
                  </THead>
                  <TBody>
                    {billing.invoices.map((invoice) => (
                      <TR key={invoice.id}>
                        <TD>
                          <span className="font-mono text-sm text-ink">{invoice.invoiceNumber}</span>
                          <span className="block text-sm text-ink-3">
                            Due {formatCalendarDate(invoice.dueOn)}
                            {invoice.paymentReference ? ` · ${invoice.paymentReference}` : ""}
                            {invoice.voidReason ? ` · ${invoice.voidReason}` : ""}
                          </span>
                        </TD>
                        <TD className="hidden md:table-cell">
                          {formatCalendarDate(invoice.periodStartsOn)} –{" "}
                          {formatCalendarDate(invoice.periodEndsOn)}
                        </TD>
                        <TD className="text-right tabular-nums">{formatCedis(invoice.totalPesewas)}</TD>
                        <TD>
                          <InvoiceState invoice={invoice} />
                        </TD>
                        <TD>
                          {(invoice.state === "open" || invoice.state === "overdue") && (
                            <InvoiceActions
                              invoiceNumber={invoice.invoiceNumber}
                              today={today}
                              markPaid={markInvoicePaidAction.bind(null, school.id, invoice.id)}
                              markVoid={voidInvoiceAction.bind(null, school.id, invoice.id)}
                            />
                          )}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableFrame>
            )}
          </Section>

          <Section
            title="Proprietor access"
            description="Creating a new link revokes any pending link for that email."
          >
            <ReissueInvitationForm
              action={reissueInvitationAction.bind(null, school.id)}
              defaultEmail={lastOwnerInvite?.email ?? ""}
            />
          </Section>

          <Section title="Invitations" description="The 20 most recent.">
            {school.invitations.length === 0 ? (
              <p className="text-base text-ink-3">No invitations yet.</p>
            ) : (
              <TableFrame>
                <Table>
                  <THead>
                    <tr>
                      <TH>Email</TH>
                      <TH className="hidden sm:table-cell">Role</TH>
                      <TH>State</TH>
                      <TH className="hidden md:table-cell" numeric>
                        Issued
                      </TH>
                    </tr>
                  </THead>
                  <TBody>
                    {school.invitations.map((invite) => (
                      <TR key={invite.id}>
                        <TD className="text-ink">{invite.email}</TD>
                        <TD className="hidden capitalize sm:table-cell">{invite.roles.join(", ")}</TD>
                        <TD>
                          <Badge tone={INVITE_TONE[invite.state]}>
                            {invite.state[0]!.toUpperCase() + invite.state.slice(1)}
                          </Badge>
                        </TD>
                        <TD className="hidden md:table-cell" numeric>
                          {formatDate(invite.createdAt, tz)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableFrame>
            )}
          </Section>
        </div>

        <div className="space-y-10">
          <Section title="Details">
            <DescriptionList
              stacked
              items={[
                { term: "Country", detail: countryName(school.countryCode) },
                { term: "Currency", detail: school.currencyCode },
                { term: "Time zone", detail: tz.replace("_", " ") },
                { term: "Created", detail: formatDate(school.createdAt, tz) },
              ]}
            />
          </Section>
          <Section
            title="Support access"
            description="Only while the Proprietor allows it, for the time they chose. Everything you open and change is shown to them."
          >
            {support && school.status === "active" ? (
              <div className="space-y-3">
                <StatusText tone="caution">Allowed until {formatDateTime(support.expiresAt, tz)}</StatusText>
                <p className="text-sm text-ink-3">
                  By {support.grantedBy}
                  {support.note ? `: “${support.note}”` : "."}
                </p>
                <Link
                  href={`/s/${school.slug}` as Route}
                  className="inline-flex h-10 items-center rounded-md border border-line-strong px-3 text-sm font-medium text-ink hover:bg-subtle"
                >
                  Open the school as support
                </Link>
              </div>
            ) : (
              <p className="text-sm text-ink-2">
                Not allowed. The Proprietor can allow it under Settings, Support access.
              </p>
            )}
          </Section>
          <Section title="Access">
            <StatusControl
              action={setSchoolStatusAction.bind(
                null,
                school.id,
                school.status === "active" ? "suspended" : "active",
              )}
              status={school.status}
              schoolName={school.name}
            />
          </Section>
        </div>
      </div>
    </div>
  );
}
