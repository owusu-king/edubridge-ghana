import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { SchoolShell } from "@/components/shell/school-shell";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/layout";
import { SubNav } from "@/components/ui/sub-nav";
import { Wordmark } from "@/components/ui/wordmark";
import { requireUser, resolveAccountArea } from "@/web/auth";
import { signOut } from "@/app/actions/sign-out";

export const metadata: Metadata = { title: { default: "Account", template: "%s · Account · EduBridge" } };

/**
 * The person's own account, framed by the school they came from (its sidebar and brand), or the platform
 * area. While a school's two-step rule is still unmet it stands alone, with only what that setup needs.
 */
export default async function AccountLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const area = await resolveAccountArea(user);
  const content = (
    <div className="space-y-10">
      <div className="space-y-6">
        <PageHeader
          eyebrow="Your account"
          title={user.name}
          description={user.email}
          bordered={false}
          actions={
            <form action={signOut}>
              <Button type="submit" variant="danger-outline">
                Sign out
              </Button>
            </form>
          }
        />
        <SubNav
          label="Account"
          items={[
            { label: "Profile", href: "/account" },
            { label: "Security", href: "/account/security" },
            { label: "Devices", href: "/account/devices" },
          ]}
        />
      </div>
      {children}
    </div>
  );

  if (area?.kind === "school") {
    return (
      <SchoolShell user={user} ctx={area.ctx}>
        {content}
      </SchoolShell>
    );
  }
  if (area?.kind === "platform") {
    return (
      <AppShell
        area={{ kind: "platform" }}
        user={{ name: user.name, email: user.email }}
        isPlatformAdmin
        signOut={signOut}
      >
        {content}
      </AppShell>
    );
  }
  return (
    <div className="flex min-h-dvh flex-col bg-surface">
      <header className="flex items-center border-b border-line bg-canvas px-5 py-3 sm:px-8">
        <Wordmark />
      </header>
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-5 py-8 sm:px-8 sm:py-12">
        {content}
      </main>
    </div>
  );
}
