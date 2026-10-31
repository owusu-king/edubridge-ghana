import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/components/ui/sub-nav";
import { Wordmark } from "@/components/ui/wordmark";
import { requireUser } from "@/web/auth";
import { signOut } from "@/app/actions/sign-out";

export const metadata: Metadata = { title: { default: "Account", template: "%s · Account · EduBridge" } };

export default async function AccountLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <header className="flex items-center justify-between border-b border-line bg-canvas px-5 py-3 sm:px-8">
        <Wordmark />
        <form action={signOut}>
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      </header>
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-5 py-8 sm:px-8 sm:py-12">
        <Link href="/" className="mb-6 inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink">
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back
        </Link>
        <div className="space-y-6">
          <PageHeader title="Your account" description={user.email} bordered={false} />
          <SubNav
            label="Account"
            items={[
              { label: "Profile", href: "/account" },
              { label: "Security", href: "/account/security" },
            ]}
          />
        </div>
        <div className="mt-8">{children}</div>
      </main>
    </div>
  );
}
