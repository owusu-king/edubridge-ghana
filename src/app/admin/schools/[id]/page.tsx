import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, StatusText } from "@/components/ui/badge";
import { DescriptionList, PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { db } from "@/server/db/client";
import { getSchool } from "@/server/platform/service";
import { countryName, formatDate } from "@/lib/format";
import { requirePlatformAdmin } from "@/web/auth";
import { reissueInvitationAction, setSchoolStatusAction, updateEntitlementsAction } from "../../actions";
import { EntitlementsForm, ReissueInvitationForm, StatusControl } from "./school-controls";

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
  const school = await getSchool(db(), user.id, id);
  if (!school) notFound();
  const tz = school.timezone;
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
              defaults={school.entitlements ?? { planName: "Pilot", maxCampuses: 1, maxStudents: null }}
            />
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
