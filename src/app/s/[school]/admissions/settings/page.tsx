import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChoiceForm } from "@/components/ui/action-forms";
import { CopyField } from "@/components/ui/copy-field";
import { Section } from "@/components/ui/layout";
import { admissionOptions } from "@/server/admissions/service";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { currencySymbol, minorToInput } from "@/lib/money";
import { requireTenant } from "@/web/auth";
import { saveAdmissionFeesAction, saveOnlineApplicationsAction } from "../actions";
import { AdmissionFeesForm } from "../admission-controls";

export const metadata: Metadata = { title: "Admissions settings" };

export default async function AdmissionsSettingsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const canManage = allowed(ctx, "admissions.manage");
  const canSetFees = allowed(ctx, "fees.manage");
  if (!canManage && !canSetFees) notFound();
  const slug = ctx.tenant.slug;
  const options = await admissionOptions(db(), ctx);
  const link = `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/apply/${slug}`;

  return (
    <div className="space-y-12">
      {canManage && (
        <Section
          title="Online applications"
          description="A form families fill in on their phone. Their number is confirmed by an SMS code, which your school pays for like any SMS."
        >
          <ChoiceForm
            action={saveOnlineApplicationsAction.bind(null, slug)}
            name="onlineApplications"
            label="Online applications"
            value={options.onlineApplications ? "on" : "off"}
            options={[
              { value: "off", label: "Not taking applications online" },
              {
                value: "on",
                label: "Families can apply online",
                description: "Share the link below on your website, social media or WhatsApp.",
              },
            ]}
          />
          {options.onlineApplications && ctx.tenant.isDemo && (
            <p className="text-sm text-ink-3">
              Demo schools are not open to the public, so the form stays closed.
            </p>
          )}
          {options.onlineApplications && !ctx.tenant.isDemo && (
            <CopyField label="Application form" value={link} />
          )}
        </Section>
      )}
      <Section
        title="Admission fees"
        description={
          canSetFees
            ? "Charged to a new student's account when they are enrolled. Each offer keeps the fees as they were when it was made."
            : "Charged on enrolment. The Proprietor or Accountant sets them."
        }
      >
        {canSetFees ? (
          <AdmissionFeesForm
            action={saveAdmissionFeesAction.bind(null, slug)}
            currencySymbol={currencySymbol(ctx.tenant.currencyCode)}
            fees={options.admissionFees.map((f) => ({
              description: f.description,
              amount: minorToInput(f.amountPesewas, ctx.tenant.currencyCode),
            }))}
          />
        ) : options.admissionFees.length === 0 ? (
          <p className="text-base text-ink-3">None set.</p>
        ) : (
          <ul className="space-y-1 text-base text-ink">
            {options.admissionFees.map((f, i) => (
              <li key={i}>
                {f.description}: {minorToInput(f.amountPesewas, ctx.tenant.currencyCode)}{" "}
                {currencySymbol(ctx.tenant.currencyCode)}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
