import type { Metadata } from "next";
import { SettingRow } from "@/components/ui/layout";
import { getVerifiedPhone } from "@/server/auth/phone";
import { db } from "@/server/db/client";
import { requireUser } from "@/web/auth";
import { PhoneSection } from "./phone-form";
import { ProfileForm } from "./account-forms";
import { PushToggle } from "@/components/parents/push-toggle";
import { pushPublicKey } from "@/server/parents/push";
import { removeStaffPushAction, saveStaffPushAction } from "./actions";

export const metadata: Metadata = { title: "Profile" };

/** Who you are and how to reach you: your name, your phone and notifications on this device. */
export default async function AccountPage() {
  const user = await requireUser();
  const phone = await getVerifiedPhone(db(), user.id);
  const publicKey = pushPublicKey();
  return (
    <div className="divide-y divide-line">
      <SettingRow
        title="Name"
        description="How colleagues see you across EduBridge, in every school you belong to."
      >
        <ProfileForm name={user.name} />
      </SettingRow>
      <SettingRow
        title="Phone number"
        description="Used for sign-in and account recovery by SMS. Enter it with the country code, or Ghanaian numbers as 024 123 4567."
      >
        <PhoneSection phone={phone} />
      </SettingRow>
      {publicKey && (
        <SettingRow
          title="Notifications"
          description="Be told on this device when something needs you. Each device is set separately."
        >
          <PushToggle
            audience="staff"
            framed={false}
            publicKey={publicKey}
            save={saveStaffPushAction}
            remove={removeStaffPushAction}
          />
        </SettingRow>
      )}
    </div>
  );
}
