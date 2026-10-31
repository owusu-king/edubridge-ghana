import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Users } from "lucide-react";
import { Badge, StatusText } from "@/components/ui/badge";
import { Avatar, EmptyState, PageHeader } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { can, ROLE_LABELS } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listMembers } from "@/server/tenancy/service";
import { formatDate, formatDateTime, initials } from "@/lib/format";
import { requireTenant } from "@/web/auth";

export const metadata: Metadata = { title: "Members" };

export default async function MembersPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "members.view")) notFound();
  const members = await listMembers(db(), ctx);
  const tz = ctx.tenant.timezone;
  const active = members.filter((m) => m.status === "active").length;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Members"
        description={`Everyone with access to ${ctx.tenant.name}. ${active} active of ${members.length}.`}
      />

      {members.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title="No members yet"
          description="People appear here once they have access to this school."
        />
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Members of {ctx.tenant.name}</caption>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Roles</TH>
                <TH className="hidden md:table-cell">Status</TH>
                <TH className="hidden lg:table-cell">Last sign-in</TH>
                <TH className="hidden sm:table-cell" numeric>
                  Joined
                </TH>
              </tr>
            </THead>
            <TBody>
              {members.map((member) => (
                <TR key={member.membershipId}>
                  <TD>
                    <div className="flex items-center gap-3">
                      <Avatar label={member.name} initials={initials(member.name)} size="sm" />
                      <div className="min-w-0">
                        <p className="truncate font-medium text-ink">{member.name}</p>
                        <p className="truncate text-sm text-ink-3">{member.email}</p>
                      </div>
                    </div>
                  </TD>
                  <TD>
                    <span className="flex flex-wrap gap-1">
                      {member.roles.map((role) => (
                        <Badge key={role}>{ROLE_LABELS[role]}</Badge>
                      ))}
                    </span>
                  </TD>
                  <TD className="hidden md:table-cell">
                    {member.status === "active" ? (
                      <StatusText tone="positive">Active</StatusText>
                    ) : (
                      <StatusText tone="neutral">Suspended</StatusText>
                    )}
                  </TD>
                  <TD className="hidden lg:table-cell">
                    {member.lastLoginAt ? (
                      formatDateTime(member.lastLoginAt, tz)
                    ) : (
                      <span className="text-ink-3">Never</span>
                    )}
                  </TD>
                  <TD className="hidden sm:table-cell" numeric>
                    {formatDate(member.joinedAt, tz)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </div>
  );
}
