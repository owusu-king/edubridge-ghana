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
import { formatPhone } from "@/lib/phone";
import { requireParent } from "@/web/parent-auth";

export const metadata: Metadata = { title: { absolute: "Your children · EduBridge for parents" } };

const STATUS: Record<string, string> = { withdrawn: "Withdrawn", graduated: "Graduated" };

/** Family home (PRT-01): every child the parent's number reaches, at every school, with the balance. */
export default async function ParentHome() {
  const { phone } = await requireParent();
  const [schools, news, consents] = await Promise.all([
    listParentChildren(db(), phone),
    listParentAnnouncements(db(), phone),
    listConsentRequests(db(), phone),
  ]);
  const unread = new Map(news.map((n) => [n.slug, n.unread]));
  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-display text-2xl font-medium tracking-tight">Your children</h1>
        <p className="mt-1 text-sm text-ink-3">Signed in with {formatPhone(phone)}</p>
      </header>
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
              <h2 id={`school-${school.slug}`} className="text-md font-semibold text-ink">
                {school.name}
              </h2>
              <Link
                href={`/p/${school.slug}/news` as Route}
                prefetch={false}
                className="-mr-2 inline-flex h-11 shrink-0 items-center gap-2 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft"
              >
                School news
                {(unread.get(school.slug) ?? 0) > 0 && (
                  <Badge tone="accent">{unread.get(school.slug)} new</Badge>
                )}
              </Link>
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
                      <ChildFacts child={child} />
                    </div>
                    <BalanceFigure pesewas={child.balancePesewas} />
                    <ChevronRight aria-hidden="true" className="mt-3 size-4 shrink-0 text-ink-3" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
