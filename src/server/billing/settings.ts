import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { parseCedis } from "../../lib/money";
import type { Database, Queryable } from "../db/client";
import { withUser } from "../db/context";
import { platformEvents, platformSettings } from "../db/schema";
import { assertPlatformAdmin } from "../platform/service";
import { readPlatformSettings, type PlatformSettings } from "./state";

/**
 * Platform-wide billing settings (one row): the default price of an SMS charged to schools, and the grace
 * period after an invoice falls due. Schools can have their own SMS price on their plan.
 */

/** The platform's default SMS price, in Ghana cedis (EduBridge's base currency; schools elsewhere get their own price). */
const settingsSchema = z.object({
  smsPrice: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z
      .string()
      .transform((text, ctx) => {
        const pesewas = parseCedis(text);
        if (pesewas === null || pesewas > 100_000) {
          ctx.addIssue({ code: "custom", message: "Enter a price per SMS, like 0.05." });
          return z.NEVER;
        }
        return pesewas;
      })
      .optional(),
  ),
  whatsappPrice: z.preprocess(
    (v) => (v === "" || v === null ? undefined : v),
    z
      .string()
      .transform((text, ctx) => {
        const pesewas = parseCedis(text);
        if (pesewas === null || pesewas > 100_000) {
          ctx.addIssue({ code: "custom", message: "Enter a price per WhatsApp message, like 0.10." });
          return z.NEVER;
        }
        return pesewas;
      })
      .optional(),
  ),
  graceDays: z.coerce
    .number()
    .int("Use a whole number.")
    .min(0, "Use 0 or more.")
    .max(60, "Use 60 or fewer."),
});

const percent = (max: number) =>
  z.coerce
    .number({ message: "Enter a percentage, like 12." })
    .min(0, "Use 0 or more.")
    .max(max, `Use ${max} or less.`);

const invoicingSchema = z.object({
  autoInvoicing: z.preprocess((v) => v === "on" || v === true, z.boolean()),
  censusDays: z.coerce
    .number()
    .int("Use a whole number.")
    .min(0, "Use 0 or more.")
    .max(60, "Use 60 or fewer."),
  invoiceDueDays: z.coerce
    .number()
    .int("Use a whole number.")
    .min(1, "Use 1 or more.")
    .max(90, "Use 90 or fewer."),
  annualDiscount: percent(50),
  monthlySurcharge: percent(50),
});

/**
 * Automatic invoices (founder, 2026-11-18): whether they are issued, the census day, the days to pay and the
 * yearly discount and monthly surcharge. Recorded in the platform log.
 */
export async function updateInvoicingSettings(
  database: Database,
  actorUserId: string,
  input: unknown,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  const data = invoicingSchema.parse(input);
  const values = {
    autoInvoicing: data.autoInvoicing,
    censusDays: data.censusDays,
    invoiceDueDays: data.invoiceDueDays,
    annualDiscountBp: Math.round(data.annualDiscount * 100),
    monthlySurchargeBp: Math.round(data.monthlySurcharge * 100),
  };
  await withUser(database, actorUserId, async (tx) => {
    await tx
      .update(platformSettings)
      .set({ ...values, updatedAt: new Date(), updatedByUserId: actorUserId })
      .where(eq(platformSettings.id, true));
    await tx
      .insert(platformEvents)
      .values({ actorUserId, action: "billing.invoicing_settings_changed", metadata: values });
  });
}

export async function getPlatformSettings(
  database: Database,
  actorUserId: string,
): Promise<PlatformSettings> {
  await assertPlatformAdmin(database, actorUserId);
  return readPlatformSettings(database);
}

export async function updatePlatformSettings(
  database: Database,
  actorUserId: string,
  input: unknown,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  const data = settingsSchema.parse(input);
  await withUser(database, actorUserId, (tx) =>
    tx
      .update(platformSettings)
      .set({
        smsPricePesewas: data.smsPrice ?? null,
        whatsappPricePesewas: data.whatsappPrice ?? null,
        graceDays: data.graceDays,
        updatedAt: new Date(),
        updatedByUserId: actorUserId,
      })
      .where(eq(platformSettings.id, true)),
  );
}

export interface InvoiceDetails {
  /** EduBridge as it appears on invoices: legal name, address, tax number. */
  issuer: string | null;
  /** How schools pay (bank or Mobile Money details). */
  paymentInstructions: string | null;
}

/** What every EduBridge invoice prints about EduBridge and how to pay it (SUB-03). */
export async function readInvoiceDetails(db: Queryable): Promise<InvoiceDetails> {
  const [row] = await db
    .select({
      issuer: platformSettings.invoiceIssuerDetails,
      paymentInstructions: platformSettings.invoicePaymentInstructions,
    })
    .from(platformSettings)
    .limit(1);
  return row ?? { issuer: null, paymentInstructions: null };
}

const invoiceText = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.string().trim().max(500, "Use 500 characters or fewer.").nullable(),
);

export async function updateInvoiceDetails(
  database: Database,
  actorUserId: string,
  input: unknown,
): Promise<void> {
  await assertPlatformAdmin(database, actorUserId);
  const data = z.object({ issuer: invoiceText, paymentInstructions: invoiceText }).parse(input);
  await withUser(database, actorUserId, (tx) =>
    tx
      .update(platformSettings)
      .set({
        invoiceIssuerDetails: data.issuer,
        invoicePaymentInstructions: data.paymentInstructions,
        updatedAt: new Date(),
        updatedByUserId: actorUserId,
      })
      .where(eq(platformSettings.id, true)),
  );
}

/** The invoice details, for platform staff editing them. */
export async function getInvoiceDetails(database: Database, actorUserId: string): Promise<InvoiceDetails> {
  await assertPlatformAdmin(database, actorUserId);
  return readInvoiceDetails(database);
}
