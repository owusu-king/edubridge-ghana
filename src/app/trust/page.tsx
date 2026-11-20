import type { Metadata, Route } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/ui/wordmark";

/** Read the hosting and backup lines from the running deployment, not the build. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "How we protect school data",
  description: "How EduBridge keeps each school's records, money and children's information safe.",
};

/**
 * The public trust page (2026-11-18): what EduBridge does to protect a school's records, written for proprietors and
 * parents. Every statement describes something the product enforces today. Where data is hosted and how often it is
 * backed up are added from the deployment's own settings (TRUST_HOSTING, TRUST_BACKUPS), so the page never claims
 * more than the running service does.
 */
const SECTIONS: { title: string; points: string[] }[] = [
  {
    title: "Each school's records are its own",
    points: [
      "Every school's records are separated by the database itself, not only by the application: a request for one school cannot read another's, even through a mistake in our code.",
      "An automated check fails our build if any new table is created without that separation.",
      "Staff see what their role needs. Teachers see their own classes; a cashier sees payments, not report cards; safeguarding cases are open only to the leads the Proprietor appoints, and the database enforces it.",
    ],
  },
  {
    title: "Money records cannot be changed after the fact",
    points: [
      "Recorded payments and fee entries can never be edited or deleted, by anyone, including EduBridge. A mistake is corrected with a reversal or a voided receipt, and both stay on record with who did it and why.",
      "Receipt numbers run without gaps. Closed periods refuse back-dated entries.",
      "A Mobile Money payment is recorded only after we ask the provider directly that it went through, for the exact amount. Payments are compared with the provider every day.",
      "Cash and cheques can be followed from the receipt to the bank deposit and the bank statement.",
      "Checks point the Proprietor to unusual activity: the same reference on two receipts, many voids by one person, receipts entered late at night, cash not banked.",
    ],
  },
  {
    title: "Signing in",
    points: [
      "Passwords are stored only as strong one-way hashes. Two-step verification is available to everyone and required by default for the Proprietor and the Accountant.",
      "Parents sign in with a code sent to their phone; there is no password to forget or share. Balance links in fee reminders are read-only and expire after seven days.",
      "Access is checked on every request, so suspending a member takes effect immediately.",
    ],
  },
  {
    title: "EduBridge staff",
    points: [
      "Our support team can open a school's records only when its Proprietor grants access, for a limited time. Every page they open is recorded and visible to the school.",
      "Support never sees safeguarding cases or early-warning indicators, and cannot export a school's records.",
    ],
  },
  {
    title: "A record of who did what",
    points: [
      "Sensitive actions (payments, voids, refunds, changes to fees, marks and access) are recorded with who did them and when, in a log that cannot be edited.",
    ],
  },
  {
    title: "Your data stays yours",
    points: [
      "The Proprietor can download the school's records at any time as spreadsheets: students, guardians, fees, payments, marks, attendance, the audit log and more.",
      "Personal details on admission applications that were closed are removed after 12 months.",
    ],
  },
  {
    title: "AI features",
    points: [
      "AI features are off unless the Proprietor turns them on. They can only read what the person asking is allowed to see, and never change records.",
      "Unless the school allows it, children's and staff names are replaced before anything is sent to an AI provider. Figures in answers are checked against the school's records.",
    ],
  },
];

export default function TrustPage() {
  const hosting = process.env.TRUST_HOSTING?.trim();
  const backups = process.env.TRUST_BACKUPS?.trim();
  const operations = [hosting, backups].filter((x): x is string => Boolean(x));
  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col px-5 py-6 sm:px-8">
      <header>
        <Link href={"/login" as Route} aria-label="EduBridge sign in">
          <Wordmark />
        </Link>
      </header>
      <main className="flex-1 py-12">
        <h1 className="font-display text-2xl font-medium tracking-tight">How we protect school data</h1>
        <p className="mt-3 max-w-2xl text-md text-ink-2">
          Schools trust EduBridge with children&apos;s records and with their money. This is what we do to
          deserve it.
        </p>
        <div className="mt-10 space-y-10">
          {[
            ...SECTIONS,
            ...(operations.length ? [{ title: "Hosting and backups", points: operations }] : []),
          ].map((section) => (
            <section key={section.title} aria-labelledby={section.title}>
              <h2 id={section.title} className="text-lg font-semibold text-ink">
                {section.title}
              </h2>
              <ul className="mt-3 list-disc space-y-2 pl-5 text-base text-ink-2">
                {section.points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="mt-12 border-t border-line pt-6 text-sm text-ink-3">
          Questions about a school&apos;s data, or a request about your own, go to your school first; it
          decides how its records are used. Schools can reach EduBridge through their Settings, Support page.
        </p>
      </main>
    </div>
  );
}
