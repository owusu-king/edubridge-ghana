import type { Metadata } from "next";
import { Section } from "@/components/ui/layout";
import { PASSWORD_MIN_LENGTH } from "@/server/auth/password";
import { requireUser } from "@/web/auth";
import { PasswordForm, ProfileForm, SignOutOthersForm } from "./account-forms";

export const metadata: Metadata = { title: "Profile" };

export default async function AccountPage() {
  const user = await requireUser();
  return (
    <div className="space-y-12">
      <Section title="Profile">
        <ProfileForm name={user.name} />
      </Section>
      <Section title="Password" description="Changing your password signs you out on other devices.">
        <PasswordForm minLength={PASSWORD_MIN_LENGTH} email={user.email} />
      </Section>
      <Section
        title="Sessions"
        description="If you signed in on a shared or lost device, end those sessions here."
      >
        <SignOutOthersForm />
      </Section>
    </div>
  );
}
