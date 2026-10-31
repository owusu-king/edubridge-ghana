import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Section } from "@/components/ui/layout";
import { can } from "@/server/authz/permissions";
import { getPlanUsage, listCampuses } from "@/server/campuses/service";
import { db } from "@/server/db/client";
import { formatDate } from "@/lib/format";
import { requireTenant } from "@/web/auth";
import { addCampusAction, renameCampusAction, setCampusStatusAction } from "./actions";
import { AddCampusForm, CampusTable } from "./campus-manager";

export const metadata: Metadata = { title: "Settings · Campuses" };

export default async function CampusesPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "campuses.manage")) notFound();
  const [campuses, usage] = await Promise.all([listCampuses(db(), ctx), getPlanUsage(db(), ctx)]);
  const slug = ctx.tenant.slug;
  const canManage = ctx.campusIds === null;
  const atLimit = usage.activeCampuses >= usage.maxCampuses;

  return (
    <div className="space-y-8">
      <Section
        title="Campuses"
        description={`${usage.activeCampuses} of ${usage.maxCampuses} active ${usage.maxCampuses === 1 ? "campus" : "campuses"} on your ${usage.planName} plan.`}
      >
        <CampusTable
          campuses={campuses.map((c) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            createdLabel: formatDate(c.createdAt, ctx.tenant.timezone),
            rename: renameCampusAction.bind(null, slug, c.id),
            toggle: setCampusStatusAction.bind(
              null,
              slug,
              c.id,
              c.status === "active" ? "archived" : "active",
            ),
          }))}
        />
      </Section>
      {canManage && (
        <div className="max-w-xl">
          <AddCampusForm
            action={addCampusAction.bind(null, slug)}
            disabledReason={
              atLimit
                ? `Your plan allows ${usage.maxCampuses} active ${usage.maxCampuses === 1 ? "campus" : "campuses"}. Archive one or contact EduBridge to change your plan.`
                : undefined
            }
          />
        </div>
      )}
    </div>
  );
}
