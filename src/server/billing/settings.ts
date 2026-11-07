import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { parseCedis } from "../../lib/money";
import type { Database } from "../db/client";
import { withUser } from "../db/context";
import { platformSettings } from "../db/schema";
import { assertPlatformAdmin } from "../platform/service";
import { readPlatformSettings, type PlatformSettings } from "./state";

/**
 * Platform-wide billing settings (one row): the default price of an SMS charged to schools, and the grace
 * period after an invoice falls due. Schools can have their own SMS price on their plan.
 */

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
  graceDays: z.coerce
    .number()
    .int("Use a whole number.")
    .min(0, "Use 0 or more.")
    .max(60, "Use 60 or fewer."),
});

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
        graceDays: data.graceDays,
        updatedAt: new Date(),
        updatedByUserId: actorUserId,
      })
      .where(eq(platformSettings.id, true)),
  );
}
