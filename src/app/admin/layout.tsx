import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { requirePlatformAdmin } from "@/web/auth";
import { signOut } from "@/app/actions/sign-out";

export const metadata: Metadata = { title: { default: "Platform", template: "%s · Platform · EduBridge" } };

export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const user = await requirePlatformAdmin();
  return (
    <AppShell
      area={{ kind: "platform" }}
      user={{ name: user.name, email: user.email }}
      isPlatformAdmin
      signOut={signOut}
    >
      {children}
    </AppShell>
  );
}
