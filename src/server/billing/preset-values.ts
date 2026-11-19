import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { isFeature } from "../../lib/plan";
import type { Transaction } from "../db/client";
import { planPresets } from "../db/schema";
import { DomainError } from "../errors";

/** Reading a plan preset and what it sets on a school's plan (shared by school creation and plan changes). */

const UUID = z.string().uuid();

export async function readPreset(tx: Transaction, presetId: string, { offered }: { offered: boolean }) {
  if (!UUID.safeParse(presetId).success) return null;
  const [row] = await tx.select().from(planPresets).where(eq(planPresets.id, presetId));
  if (!row || (offered && row.archivedAt)) return null;
  return row;
}

/**
 * What a preset sets on a school's plan: name, modules and limits; when the preset is priced in the school's
 * currency, its prices too. Prices by school size are copied (so a later change to the preset leaves the school
 * as it is) and replace any agreed price; a preset's single price sets the period and price as before. A preset
 * in another currency leaves the school's own prices.
 */
export function presetValues(preset: typeof planPresets.$inferSelect, schoolCurrency: string) {
  const sameCurrency = preset.currencyCode === schoolCurrency;
  return {
    planName: preset.name,
    features: preset.features.filter(isFeature),
    maxCampuses: preset.maxCampuses,
    maxStudents: preset.maxStudents,
    maxSmsPerMonth: preset.maxSmsPerMonth,
    planPresetId: preset.id,
    ...(sameCurrency && preset.priceBands
      ? { priceBands: preset.priceBands, pricePesewas: null }
      : sameCurrency && preset.pricePesewas !== null
        ? { billingPeriod: preset.billingPeriod, pricePesewas: preset.pricePesewas, priceBands: null }
        : {}),
  };
}

/** For school creation: the preset's values, or a clear error if it is not offered. */
export async function presetForNewSchool(tx: Transaction, presetId: string, currency: string) {
  const preset = await readPreset(tx, presetId, { offered: true });
  if (!preset) throw new DomainError("preset_not_found", "Choose a plan.", "presetId");
  return presetValues(preset, currency);
}
