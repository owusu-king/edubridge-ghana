import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Section } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getRules } from "@/server/library/loans";
import { formatMoney, minorToInput } from "@/lib/money";
import { requireTenant } from "@/web/auth";
import { saveFineRulesAction, saveLoanRulesAction } from "../actions";
import { FineRulesForm, LoanRulesForm } from "../library-controls";

export const metadata: Metadata = { title: "Library · Settings" };

/** Loan rules (the library) and fines (those who manage fees) (LIB-01c, LIB-02). */
export default async function LibrarySettingsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  const manage = allowed(ctx, "library.manage");
  const fees = allowed(ctx, "fees.manage") && allowed(ctx, "library.view");
  if (!manage && !fees) notFound();
  const slug = ctx.tenant.slug;
  const currency = ctx.tenant.currencyCode;
  const rules = await getRules(db(), ctx);

  return (
    <div className="space-y-10">
      <Section
        title="Loans"
        description="New loans and renewals use these; books already out keep their due date."
      >
        {manage ? (
          <LoanRulesForm
            action={saveLoanRulesAction.bind(null, slug)}
            loanDays={rules.loanDays}
            maxLoans={rules.maxLoans}
          />
        ) : (
          <p className="text-base text-ink">
            {rules.loanDays} days, up to {rules.maxLoans} books at once.
          </p>
        )}
      </Section>
      <Section
        title="Fines"
        description="A fine is waived by reversing it on the student's fee account, like any charge."
      >
        {fees ? (
          <FineRulesForm
            action={saveFineRulesAction.bind(null, slug)}
            currency={currency}
            enabled={rules.finesEnabled}
            perDay={minorToInput(rules.finePerDayMinor, currency)}
            cap={minorToInput(rules.fineCapMinor, currency)}
          />
        ) : (
          <p className="text-base text-ink">
            {rules.finesEnabled && rules.finePerDayMinor
              ? `${formatMoney(rules.finePerDayMinor, currency)} a day late${rules.fineCapMinor ? `, at most ${formatMoney(rules.fineCapMinor, currency)} a book` : ""}.`
              : "No fines."}
            <span className="block text-sm text-ink-3">The Proprietor or Accountant sets fines.</span>
          </p>
        )}
      </Section>
    </div>
  );
}
