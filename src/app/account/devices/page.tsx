import type { Metadata } from "next";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { listDeviceTokens } from "@/server/auth/device-tokens";
import { db } from "@/server/db/client";
import { formatDateTime } from "@/lib/format";
import { requireUser } from "@/web/auth";
import { revokeDeviceAction } from "./actions";
import { RevokeDeviceButton } from "./revoke-button";

export const metadata: Metadata = { title: "Devices" };

/** Apps and devices signed in to the EduBridge API with this account, each revocable. */
export default async function DevicesPage() {
  const user = await requireUser();
  const devices = await listDeviceTokens(db(), user.id);
  const when = (d: Date) => formatDateTime(d, "Africa/Accra");
  return (
    <Section
      title="Signed-in devices"
      description="Apps and devices that use EduBridge with your account (for example a phone app or a device that syncs registers). Sign out any you do not recognise. Changing your password signs them all out."
    >
      {devices.length === 0 ? (
        <p className="text-base text-ink-2">No apps or devices are signed in with your account.</p>
      ) : (
        <TableFrame>
          <Table>
            <THead>
              <tr>
                <TH>Device</TH>
                <TH>Signed in</TH>
                <TH>Last used</TH>
                <TH>
                  <span className="sr-only">Actions</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {devices.map((d) => (
                <TR key={d.handle}>
                  <TD className="text-ink">{d.name}</TD>
                  <TD className="whitespace-nowrap">{when(d.createdAt)}</TD>
                  <TD className="whitespace-nowrap">{d.lastUsedAt ? when(d.lastUsedAt) : "Not yet"}</TD>
                  <TD className="text-right">
                    <RevokeDeviceButton action={revokeDeviceAction.bind(null, d.handle)} name={d.name} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </Section>
  );
}
