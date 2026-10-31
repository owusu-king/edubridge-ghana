import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Users } from "lucide-react";
import { Badge, StatusText } from "@/components/ui/badge";
import { Avatar, EmptyState, PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { can, ROLE_LABELS, isRole } from "@/server/authz/permissions";
import { listCampuses } from "@/server/campuses/service";
import { db } from "@/server/db/client";
import { ASSIGNABLE_ROLES, listPendingInvitations } from "@/server/members/service";
import { listMembers } from "@/server/tenancy/service";
import { formatDate, formatDateTime, initials } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import {
  inviteMemberAction,
  reissueInvitationAction,
  revokeInvitationAction,
  setMemberStatusAction,
  updateMemberAction,
} from "./actions";
import { InvitationActions, InviteMemberDialog, MemberActions } from "./member-controls";

export const metadata: Metadata = { title: "Members" };

export default async function MembersPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "members.view")) notFound();
  const [members, invitations, campuses] = await Promise.all([
    listMembers(db(), ctx),
    listPendingInvitations(db(), ctx),
    listCampuses(db(), ctx),
  ]);
  const tz = ctx.tenant.timezone;
  const slug = ctx.tenant.slug;
  const active = members.filter((m) => m.status === "active").length;

  const isOwner = ctx.roles.includes("owner");
  const canManage = can(ctx.roles, "members.manage") && ctx.campusIds === null;
  const roleOptions = ASSIGNABLE_ROLES.filter((r) => r !== "owner" || isOwner).map((r) => ({
    value: r,
    label: ROLE_LABELS[r],
  }));
  const activeCampuses = campuses.filter((c) => c.status === "active");
  const campusOptions = activeCampuses.map((c) => ({ value: c.id, label: c.name }));
  const campusName = new Map(campuses.map((c) => [c.id, c.name]));
  const scopeLabel = (ids: string[] | null) =>
    ids ? ids.map((id) => campusName.get(id) ?? "Unknown campus").join(", ") : "All campuses";
  const roleLabel = (r: string) => (isRole(r) ? ROLE_LABELS[r] : r);

  return (
    <div className="space-y-10">
      <PageHeader
        title="Members"
        description={`Everyone with access to ${ctx.tenant.name}. ${active} active of ${members.length}.`}
        actions={
          canManage && (
            <InviteMemberDialog
              action={inviteMemberAction.bind(null, slug)}
              roleOptions={roleOptions}
              campusOptions={campusOptions}
            />
          )
        }
      />

      {members.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title="No members yet"
          description="People appear here once they accept an invitation."
        />
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Members of {ctx.tenant.name}</caption>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Roles</TH>
                {campuses.length > 1 && <TH className="hidden xl:table-cell">Campuses</TH>}
                <TH className="hidden md:table-cell">Status</TH>
                <TH className="hidden lg:table-cell">Last sign-in</TH>
                <TH className="hidden sm:table-cell" numeric>
                  Joined
                </TH>
                {canManage && (
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                )}
              </tr>
            </THead>
            <TBody>
              {members.map((member) => {
                const memberIsOwner = member.roles.includes("owner");
                const editable = canManage && (!memberIsOwner || isOwner);
                // Parent/student-only access will move to guardian and student records; it is not edited here.
                const hasStaffRole = member.roles.some((r) =>
                  (ASSIGNABLE_ROLES as readonly string[]).includes(r),
                );
                return (
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
                    {campuses.length > 1 && (
                      <TD className="hidden xl:table-cell">{scopeLabel(member.campusIds)}</TD>
                    )}
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
                    {canManage && (
                      <TD className="text-right whitespace-nowrap">
                        <MemberActions
                          name={member.name}
                          status={member.status}
                          roles={member.roles.filter((r) =>
                            (ASSIGNABLE_ROLES as readonly string[]).includes(r),
                          )}
                          campusIds={member.campusIds}
                          canEdit={editable && hasStaffRole}
                          canChangeStatus={editable && member.userId !== ctx.userId}
                          roleOptions={roleOptions}
                          campusOptions={campusOptions}
                          update={updateMemberAction.bind(null, slug, member.membershipId)}
                          toggleStatus={setMemberStatusAction.bind(
                            null,
                            slug,
                            member.membershipId,
                            member.status === "active" ? "suspended" : "active",
                          )}
                        />
                      </TD>
                    )}
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </TableFrame>
      )}

      {invitations.length > 0 && (
        <Section title="Pending invitations" description="Links expire after 7 days and work once.">
          <TableFrame>
            <Table>
              <THead>
                <tr>
                  <TH>Email</TH>
                  <TH className="hidden sm:table-cell">Roles</TH>
                  {campuses.length > 1 && <TH className="hidden lg:table-cell">Campuses</TH>}
                  <TH className="hidden md:table-cell" numeric>
                    Expires
                  </TH>
                  {canManage && (
                    <TH>
                      <span className="sr-only">Actions</span>
                    </TH>
                  )}
                </tr>
              </THead>
              <TBody>
                {invitations.map((invite) => (
                  <TR key={invite.id}>
                    <TD className="text-ink">
                      {invite.email}
                      {invite.invitedBy && (
                        <p className="text-sm text-ink-3">Invited by {invite.invitedBy}</p>
                      )}
                    </TD>
                    <TD className="hidden sm:table-cell">{invite.roles.map(roleLabel).join(", ")}</TD>
                    {campuses.length > 1 && (
                      <TD className="hidden lg:table-cell">{scopeLabel(invite.campusIds)}</TD>
                    )}
                    <TD className="hidden md:table-cell" numeric>
                      {formatDate(invite.expiresAt, tz)}
                    </TD>
                    {canManage && (
                      <TD className="text-right whitespace-nowrap">
                        {(!invite.roles.includes("owner") || isOwner) && (
                          <InvitationActions
                            email={invite.email}
                            reissue={reissueInvitationAction.bind(null, slug, invite.id)}
                            revoke={revokeInvitationAction.bind(null, slug, invite.id)}
                          />
                        )}
                      </TD>
                    )}
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        </Section>
      )}
    </div>
  );
}
