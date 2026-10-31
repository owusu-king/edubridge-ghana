import type { Metadata, Route } from "next";
import Link from "next/link";
import { ChevronRight, School } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/layout";
import { SchoolMonogram } from "@/components/ui/monogram";
import { Wordmark } from "@/components/ui/wordmark";
import { ROLE_LABELS } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listUserSchools } from "@/server/tenancy/service";
import { requireUser } from "@/web/auth";
import { signOut } from "../actions/sign-out";
import { schoolPath } from "@/lib/routes";

export const metadata: Metadata = { title: "Your schools" };

export default async function SchoolsPage() {
  const user = await requireUser();
  const schools = await listUserSchools(db(), user.id);

  return (
    <div className="flex min-h-dvh flex-col px-5 py-6 sm:px-8">
      <header className="flex items-center justify-between">
        <Wordmark />
        <form action={signOut}>
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      </header>
      <main className="mx-auto w-full max-w-lg flex-1 py-12 sm:py-20">
        <h1 className="font-display text-2xl font-medium tracking-tight">Your schools</h1>
        <p className="mt-2 mb-8 text-base text-ink-2">Signed in as {user.email}</p>
        {schools.length === 0 ? (
          <EmptyState
            icon={<School />}
            title="No school access yet"
            description="Your account is not linked to a school. Ask your school administrator to add you."
          />
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface shadow-raised">
            {schools.map((school) => (
              <li key={school.slug}>
                <Link
                  href={schoolPath(school.slug)}
                  className="flex items-center gap-3 px-4 py-3.5 transition-colors first:rounded-t-lg last:rounded-b-lg hover:bg-canvas"
                >
                  <SchoolMonogram name={school.name} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink">{school.name}</span>
                    <span className="block truncate text-sm text-ink-3">
                      {school.roles.map((r) => ROLE_LABELS[r]).join(", ")}
                    </span>
                  </span>
                  <ChevronRight aria-hidden="true" className="size-4 text-ink-3" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
