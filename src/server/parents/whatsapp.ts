import "server-only";
import { moduleActive } from "../entitlements/service";
import { z } from "zod";
import type { Database } from "../db/client";
import { withTenant } from "../db/context";
import { whatsappContacts } from "../db/schema";
import { whatsappOptedIn } from "../notifications/outbox";
import { whatsappAvailable } from "../notifications/providers";
import { schoolsForPhone } from "./schools";

/**
 * A family's choice to get school messages on WhatsApp (WAB-01). Offered when WhatsApp is set up and at
 * least one of the number's schools has WhatsApp in its plan. The choice is the parent's own, made signed
 * in with that number (the consent record keeps when); STOP on WhatsApp or turning it off here opts out.
 */
export interface WhatsAppChoice {
  offered: boolean;
  on: boolean;
  /** The schools whose messages would come by WhatsApp. */
  schools: string[];
}

export async function getWhatsAppChoice(database: Database, phone: string): Promise<WhatsAppChoice> {
  if (!whatsappAvailable()) return { offered: false, on: false, schools: [] };
  const schools: string[] = [];
  for (const school of await schoolsForPhone(database, phone)) {
    const offered = await withTenant(database, { tenantId: school.id, userId: "" }, (tx) =>
      moduleActive(tx, school.id, "whatsapp"),
    );
    if (offered) schools.push(school.name);
  }
  return { offered: schools.length > 0, on: await whatsappOptedIn(database, phone), schools };
}

export async function setWhatsAppChoice(database: Database, phone: string, input: unknown): Promise<void> {
  const { on } = z.object({ on: z.boolean() }).parse(input);
  if (on && !(await getWhatsAppChoice(database, phone)).offered) throw new Error("WhatsApp is not offered.");
  const now = new Date();
  await database
    .insert(whatsappContacts)
    .values({ phone, source: "parent_view", ...(on ? { optedInAt: now } : { optedOutAt: now }) })
    .onConflictDoUpdate({
      target: whatsappContacts.phone,
      set: { source: "parent_view", updatedAt: now, ...(on ? { optedInAt: now } : { optedOutAt: now }) },
    });
}
