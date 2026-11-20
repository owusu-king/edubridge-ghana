import type { Metadata, Route } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { BalanceFigure, ChildFacts } from "@/components/parents/balance";
import { ConsentButtons } from "@/components/parents/transfer-forms";
import { answerConsentAction } from "./transfer-actions";
import { db } from "@/server/db/client";
import { listParentAnnouncements } from "@/server/messages/announcements";
import { listParentChildren } from "@/server/parents/portal";
import { listConsentRequests } from "@/server/passport/transfers";
import { listParentConsentForms } from "@/server/events/consent";
import { formatCalendarDate } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { requireParent } from "@/web/parent-auth";
import { InstallNote } from "@/components/parents/install-note";
import { PushToggle } from "@/components/parents/push-toggle";
import { pushPublicKey } from "@/server/parents/push";
import { removePushAction, savePushAction, setWhatsAppAction } from "./actions";
import { WhatsAppToggle } from "@/components/parents/whatsapp-toggle";
import { getWhatsAppChoice } from "@/server/parents/whatsapp";
import { parentPaymentSetup } from "@/server/mobile-money/requests";
import { schoolBySlug } from "@/server/parents/schools";

export const metadata: Metadata = { title: { absolute: "Your children · EduBridge for parents" } };

const STATUS: Record<string, string> = { withdrawn: "Withdrawn", graduated: "Graduated" };

/** Family home (PRT-01): every child the parent's number reaches, at every school, with the balance. */
export default async function ParentHome() {
  const { phone } = await requireParent();
  const [schools, news, consents, forms, whatsapp] = await Promise.all([
    listParentChildren(db(), phone),
    listParentAnnouncements(db(), phone),
    listConsentRequests(db(), phone),
    listParentConsentForms(db(), phone),
    getWhatsAppChoice(db(), phone),
  ]);
  const unread = new Map(news.map((n) => [n.slug, n.unread]));
  // One payment for several children (2026-11-18): offered where two or more owe and the school takes payments.
  const familyPay = new Set<string>();
  for (const school of schools) {
    if (school.children.filter((c) => c.balancePesewas > 0 && c.status !== "transferred").length < 2)
      continue;
    const ref = await schoolBySlug(db(), school.slug);
    if (ref && (await parentPaymentSetup(db(), ref)).enabled) familyPay.add(school.slug);
  }
  const publicKey = pushPublicKey();
  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-2xl font-medium tracking-tight">Your children</h1>
        <p className="mt-1 text-sm text-ink-3">Signed in with {formatPhone(phone)}</p>
      </header>
      <InstallNote />
      {publicKey && <PushToggle publicKey={publicKey} save={savePushAction} remove={removePushAction} />}
      {whatsapp.offered && (
        <WhatsAppToggle
          on={whatsapp.on}
          schools={whatsapp.schools}
          phone={formatPhone(phone)}
          turnOn={setWhatsAppAction.bind(null, true)}
          turnOff={setWhatsAppAction.bind(null, false)}
        />
      )}
      {consents.map((c) => (
        <section
          key={c.id}
          aria-label={`Request for ${c.childName}'s records`}
          className="space-y-3 rounded-lg border border-line-strong bg-surface px-5 py-4"
        >
          <h2 className="text-md font-semibold text-ink">
            {c.toSchoolName} asked for your child&apos;s records
          </h2>
          <p className="text-base text-ink-2">
            {c.toSchoolName} says {c.childName} is joining them and asked {c.schoolName} for their records:
            classes, report cards, attendance and guardians. If you allow it, {c.schoolName} then decides.
          </p>
          <ConsentButtons
            allow={answerConsentAction.bind(null, c.slug, c.id, true)}
            refuse={answerConsentAction.bind(null, c.slug, c.id, false)}
            child={c.childName}
          />
        </section>
      ))}
      {forms.length > 0 && (
        <section aria-labelledby="forms-waiting" className="space-y-2">
          <h2 id="forms-waiting" className="text-md font-semibold text-ink">
            Waiting for your answer
          </h2>
          <ul className="divide-y divide-line rounded-lg border border-line-strong bg-surface">
            {forms.map((f) => (
              <li key={f.id}>
                <Link
                  href={`/p/${f.slug}/forms/${f.id}` as Route}
                  className="flex items-center gap-3 px-4 py-4 hover:bg-subtle focus-visible:bg-subtle"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-base font-medium text-ink">{f.title}</p>
                    <p className="text-sm text-ink-3">
                      {f.schoolName} · for{" "}
                      {f.children
                        .filter((c) => !c.answer)
                        .map((c) => c.name)
                        .join(" and ")}{" "}
                      · by the end of {formatCalendarDate(f.deadline)}
                    </p>
                  </div>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-3" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {schools.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface px-5 py-6">
          <h2 className="text-md font-semibold text-ink">No children found for this number</h2>
          <p className="mt-2 text-base text-ink-2">
            Children appear here when their school has {formatPhone(phone)} on file for you. If it should, ask
            the school office to check the number they have.
          </p>
        </div>
      ) : (
        schools.map((school) => (
          <section key={school.slug} aria-labelledby={`school-${school.slug}`} className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2
                id={`school-${school.slug}`}
                className="flex items-center gap-3 text-md font-semibold text-ink"
              >
                {school.logoUrl && (
                  // eslint-disable-next-line @next/next/no-img-element -- the school's own logo
                  <img src={school.logoUrl} alt="" className="size-8 shrink-0 rounded-md object-contain" />
                )}
                {school.name}
              </h2>
              <div className="-mr-2 flex shrink-0 items-center">
                <Link
                  href={`/p/${school.slug}/events` as Route}
                  prefetch={false}
                  className="inline-flex h-11 items-center rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft"
                >
                  Events
                </Link>
                <Link
                  href={`/p/${school.slug}/news` as Route}
                  prefetch={false}
                  className="inline-flex h-11 items-center gap-2 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft"
                >
                  School news
                  {(unread.get(school.slug) ?? 0) > 0 && (
                    <Badge tone="accent">{unread.get(school.slug)} new</Badge>
                  )}
                </Link>
              </div>
            </div>
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface shadow-raised">
              {school.children.map((child) => (
                <li key={child.studentId}>
                  <Link
                    href={`/p/${school.slug}/${child.studentId}` as Route}
                    className="flex items-start gap-4 px-4 py-4 hover:bg-subtle focus-visible:bg-subtle"
                  >
                    <div className="min-w-0 flex-1 space-y-2">
                      <div>
                        <p className="text-base font-medium text-ink">{child.name}</p>
                        <p className="text-sm text-ink-3">
                          {[child.className, STATUS[child.status]].filter(Boolean).join(" · ") ||
                            "No class this term"}
                        </p>
                      </div>
                      <ChildFacts currency={school.currency} child={child} />
                    </div>
                    <BalanceFigure currency={school.currency} pesewas={child.balancePesewas} />
                    <ChevronRight aria-hidden="true" className="mt-3 size-4 shrink-0 text-ink-3" />
                  </Link>
                </li>
              ))}
            </ul>
            {school.children.length > 1 && (
              <div className="-ml-2 flex flex-wrap gap-x-2">
                {familyPay.has(school.slug) && (
                  <Link
                    href={`/p/${school.slug}/pay` as Route}
                    className="inline-flex h-11 items-center gap-2 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft"
                  >
                    Pay for all children at once
                  </Link>
                )}
                <a
                  href={`/p/${school.slug}/family-statement`}
                  className="inline-flex h-11 items-center gap-2 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft"
                >
                  Family statement (PDF)
                </a>
              </div>
            )}
          </section>
        ))
      )}
    </div>
  );
}
