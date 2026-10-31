import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Section } from "@/components/ui/layout";
import { can } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { suggestedAsOf } from "@/server/fees/opening-balances";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { checkBalancesAction, importBalancesAction } from "./actions";
import { BalancesImport } from "./balances-import";

export const metadata: Metadata = { title: "Fees · Opening balances" };

export default async function OpeningBalancesPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!can(ctx.roles, "fees.manage") || ctx.campusIds !== null) notFound();
  const slug = ctx.tenant.slug;
  return (
    <Section
      title="Import opening balances"
      description="Bring in what each family owed, or had paid in advance, in your records before EduBridge. Each student gets one opening balance."
    >
      <BalancesImport
        check={checkBalancesAction.bind(null, slug)}
        runImport={importBalancesAction.bind(null, slug)}
        defaultAsOf={await suggestedAsOf(db(), ctx)}
        accountsHref={schoolPath(slug, "fees/accounts")}
      />
    </Section>
  );
}
