import type { Metadata } from "next";
import { DescriptionList, Section } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getRules } from "@/server/early-warning/rules";
import { RULE_LABELS } from "@/lib/early-warning";
import { requireTenant } from "@/web/auth";
import { saveRulesAction } from "../actions";
import { RulesForm } from "../controls";

export const metadata: Metadata = { title: "Early warning · Rules" };

/** The school's early-warning rules (EWS-01a): the Proprietor or Head teacher sets them; everyone else reads them. */
export default async function RulesPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const slug = ctx.tenant.slug;
  const s = await getRules(db(), ctx);
  const off = "Off";
  return (
    <Section
      title="Rules"
      description="What the records must show for a student to be listed. Late counts as attending. Changes apply at once and are recorded."
    >
      {allowed(ctx, "early_warning.manage") ? (
        <RulesForm action={saveRulesAction.bind(null, slug)} settings={s} />
      ) : (
        <DescriptionList
          items={[
            {
              term: RULE_LABELS.attendance_low,
              detail: s.attendanceOn
                ? `Below ${s.attendancePercent}% over the last ${s.attendanceDays} days`
                : off,
            },
            {
              term: RULE_LABELS.absent_in_a_row,
              detail: s.absencesOn ? `${s.absencesInARow} or more absences in a row, without a reason` : off,
            },
            {
              term: RULE_LABELS.average_down,
              detail: s.averageOn ? `Down ${s.averageDrop} points or more from the previous card` : off,
            },
            {
              term: RULE_LABELS.subjects_below,
              detail: s.subjectsOn ? `${s.subjectsCount} or more subjects below ${s.passMark}` : off,
            },
          ]}
        />
      )}
    </Section>
  );
}
