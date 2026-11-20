import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { FamilyPayForm } from "@/components/parents/pay-forms";
import { db } from "@/server/db/client";
import { parentPaymentSetup } from "@/server/mobile-money/requests";
import { listParentChildren } from "@/server/parents/portal";
import { schoolBySlug } from "@/server/parents/schools";
import { formatPhone } from "@/lib/phone";
import { requireParent } from "@/web/parent-auth";
import { payFamilyAction } from "../../payment-actions";

export const metadata: Metadata = { title: { absolute: "Pay for your children · EduBridge for parents" } };

/** One Mobile Money payment for several children at one school (2026-11-18). */
export default async function FamilyPayPage({ params }: { params: Promise<{ school: string }> }) {
  const { school: slug } = await params;
  const { phone } = await requireParent();
  const [schools, ref] = await Promise.all([listParentChildren(db(), phone), schoolBySlug(db(), slug)]);
  const school = schools.find((s) => s.slug === slug);
  if (!school || !ref) notFound();
  const setup = await parentPaymentSetup(db(), ref);
  const owing = school.children.filter((c) => c.balancePesewas > 0 && c.status !== "transferred");

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={"/p" as Route}
          className="-ml-2 inline-flex h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Your children
        </Link>
        <h1 className="mt-2 font-display text-2xl font-medium tracking-tight">Pay for your children</h1>
        <p className="mt-1 text-sm text-ink-3">
          {school.name}. One Mobile Money approval for all of them; each child gets their own receipt.
        </p>
      </div>
      {!setup.enabled ? (
        <div className="rounded-lg border border-line bg-surface px-5 py-6">
          <h2 className="text-md font-semibold text-ink">Online payment is not available</h2>
          <p className="mt-2 text-base text-ink-2">
            {school.name} does not take Mobile Money payments here yet.
          </p>
        </div>
      ) : owing.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface px-5 py-6">
          <h2 className="text-md font-semibold text-ink">Nothing to pay</h2>
          <p className="mt-2 text-base text-ink-2">
            None of your children at {school.name} owes fees right now.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-line bg-surface px-4 py-4">
          <FamilyPayForm
            currency={school.currency}
            action={payFamilyAction.bind(null, slug)}
            childrenOwing={owing.map((c) => ({
              studentId: c.studentId,
              name: c.name,
              className: c.className,
              balancePesewas: c.balancePesewas,
            }))}
            phone={formatPhone(phone)}
            testMode={setup.testMode}
            testHint={setup.testHint}
            networks={setup.networks}
          />
        </div>
      )}
    </div>
  );
}
