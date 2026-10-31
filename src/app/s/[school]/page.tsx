import type { Metadata, Route } from "next";
import Link from "next/link";
import { DescriptionList, PageHeader, Section } from "@/components/ui/layout";
import { Badge } from "@/components/ui/badge";
import { can, ROLE_LABELS, ROLES } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { countMembersByRole } from "@/server/tenancy/service";
import { countryName } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { schoolPath } from "@/lib/routes";

export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { user, ctx } = await requireTenant(school);
  const counts = can(ctx.roles, "members.view") ? await countMembersByRole(db(), ctx) : null;
  const firstName = user.name.split(" ")[0] ?? user.name;

  return (
    <div className="space-y-10">
      <PageHeader eyebrow={`Welcome, ${firstName}`} title={ctx.tenant.name} description="School overview" />

      {counts && (
        <Section
          title="People"
          description="Active members of this school by role."
          aside={
            <Link
              href={schoolPath(ctx.tenant.slug, "members")}
              className="text-sm font-medium text-accent hover:underline"
            >
              View members
            </Link>
          }
        >
          <dl className="grid grid-cols-2 border-y border-line sm:grid-cols-3 lg:grid-cols-6">
            {ROLES.map((role) => (
              <div
                key={role}
                className="border-line py-4 pr-4 sm:[&:not(:first-child)]:border-l sm:[&:not(:first-child)]:pl-4"
              >
                <dt className="text-sm text-ink-3">{ROLE_LABELS[role]}s</dt>
                <dd className="tabular mt-1 font-display text-xl text-ink">{counts[role]}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      <Section title="School details">
        <DescriptionList
          items={[
            { term: "Country", detail: countryName(ctx.tenant.countryCode) },
            { term: "Time zone", detail: ctx.tenant.timezone.replace("_", " ") },
            { term: "Currency", detail: ctx.tenant.currencyCode },
            {
              term: "Your roles",
              detail: (
                <span className="flex flex-wrap gap-1.5">
                  {ctx.roles.map((role) => (
                    <Badge key={role}>{ROLE_LABELS[role]}</Badge>
                  ))}
                </span>
              ),
            },
          ]}
        />
      </Section>
    </div>
  );
}
