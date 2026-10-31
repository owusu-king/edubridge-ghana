import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DescriptionList, Section } from "@/components/ui/layout";
import { can } from "@/server/authz/permissions";
import { getPlanUsage } from "@/server/campuses/service";
import { db } from "@/server/db/client";
import { requireTenant } from "@/web/auth";

export const metadata: Metadata = { title: "Settings · Plan" };

export default async function PlanPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "plan.view")) notFound();
  const usage = await getPlanUsage(db(), ctx);

  return (
    <Section
      title={`${usage.planName} plan`}
      description="Limits are set by EduBridge. Contact us to change your plan."
    >
      <DescriptionList
        items={[
          {
            term: "Active campuses",
            detail: (
              <span className="tabular">
                {usage.activeCampuses} of {usage.maxCampuses}
              </span>
            ),
          },
          {
            term: "Student limit",
            detail: usage.maxStudents ? (
              <span className="tabular">{usage.maxStudents.toLocaleString("en-GH")} students</span>
            ) : (
              "No limit"
            ),
          },
        ]}
      />
    </Section>
  );
}
