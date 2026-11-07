import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SchoolContacts } from "@/components/parents/school-contacts";
import { db } from "@/server/db/client";
import { openParentSchoolNews } from "@/server/messages/announcements";
import { formatDateTime } from "@/lib/format";
import { requireParent } from "@/web/parent-auth";

export const metadata: Metadata = { title: "School news" };

/**
 * A school's announcements for this parent's children (PRT-05) and how to reach the office (PRT-06).
 * Opening the page records the announcements as read.
 */
export default async function ParentSchoolNewsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school: slug } = await params;
  const { phone } = await requireParent();
  const page = await openParentSchoolNews(db(), phone, slug);
  if (!page) notFound();

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
        <h1 className="mt-2 font-display text-2xl font-medium tracking-tight">News from {page.name}</h1>
      </div>

      {page.announcements.length === 0 ? (
        <p className="text-base text-ink-2">No announcements from the school in the last few months.</p>
      ) : (
        <ul aria-label="Announcements" className="divide-y divide-line border-y border-line">
          {page.announcements.map((a) => (
            <li key={a.id} className="space-y-2 py-5">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-md font-semibold text-ink">{a.title}</h2>
                {!a.read && <Badge tone="accent">New</Badge>}
              </div>
              <p className="text-sm text-ink-3">{formatDateTime(a.createdAt, page.timezone)}</p>
              <p className="text-base whitespace-pre-line text-ink-2">{a.body}</p>
            </li>
          ))}
        </ul>
      )}

      {page.contacts && <SchoolContacts contacts={page.contacts} schoolName={page.name} />}
    </div>
  );
}
