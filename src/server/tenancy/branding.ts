import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { isAccessibleAccent } from "../../lib/branding";
import { recordAudit } from "../audit/record";
import { assertAllowed } from "../authz/permissions";
import type { Database, Queryable } from "../db/client";
import { withTenant } from "../db/context";
import { schoolPreferences, tenants } from "../db/schema";
import { DomainError } from "../errors";
import { markRemoved, readStoredFile, storeFile } from "../files/service";
import { readPreferences } from "./preferences";
import type { TenantContext } from "./service";

/**
 * School identity (TEN-04): logo and accent colour, shown in the staff app, the parent view, receipts and
 * statements. The colour must stay readable (WCAG AA); the logo is a small image checked by its bytes.
 */

const scope = (ctx: TenantContext) => ({
  tenantId: ctx.tenant.id,
  userId: ctx.userId,
  supportGrantId: ctx.support?.grantId,
});

export interface Branding {
  brandColor: string | null;
  logoFileId: string | null;
}

export async function readBranding(tx: Queryable, tenantId: string): Promise<Branding> {
  const prefs = await readPreferences(tx, tenantId);
  return { brandColor: prefs.brandColor, logoFileId: prefs.logoFileId };
}

export async function getBranding(database: Database, ctx: TenantContext): Promise<Branding> {
  return withTenant(database, scope(ctx), (tx) => readBranding(tx, ctx.tenant.id));
}

async function upsert(
  tx: Queryable,
  ctx: TenantContext,
  values: Partial<typeof schoolPreferences.$inferInsert>,
) {
  await tx
    .insert(schoolPreferences)
    .values({ tenantId: ctx.tenant.id, ...values, updatedAt: new Date(), updatedByUserId: ctx.userId })
    .onConflictDoUpdate({
      target: schoolPreferences.tenantId,
      set: { ...values, updatedAt: new Date(), updatedByUserId: ctx.userId },
    });
}

export async function saveBrandColor(database: Database, ctx: TenantContext, input: unknown): Promise<void> {
  assertAllowed(ctx, "school.settings.manage");
  const { brandColor } = z
    .object({
      brandColor: z.preprocess(
        (v) => (v === "" || v === null || v === undefined ? null : String(v).toLowerCase()),
        z
          .string()
          .regex(/^#[0-9a-f]{6}$/, "Choose a colour like #24467a.")
          .nullable(),
      ),
    })
    .parse(input);
  if (brandColor && !isAccessibleAccent(brandColor))
    throw new DomainError(
      "colour_contrast",
      "This colour is too light for white text to be readable on it. Choose a darker shade.",
      "brandColor",
    );
  await withTenant(database, scope(ctx), async (tx) => {
    const before = await readBranding(tx, ctx.tenant.id);
    await upsert(tx, ctx, { brandColor });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "school.brand_colour_changed",
      entityType: "tenant",
      entityId: ctx.tenant.id,
      metadata: { from: before.brandColor, to: brandColor },
    });
  });
}

export async function setSchoolLogo(
  database: Database,
  ctx: TenantContext,
  file: { filename: string; bytes: Buffer },
): Promise<void> {
  assertAllowed(ctx, "school.settings.manage");
  await withTenant(database, scope(ctx), async (tx) => {
    const before = await readBranding(tx, ctx.tenant.id);
    const id = await storeFile(tx, ctx, { purpose: "school_logo", ownerId: null, ...file });
    if (before.logoFileId) await markRemoved(tx, ctx, before.logoFileId, "school_logo");
    await upsert(tx, ctx, { logoFileId: id });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "school.logo_changed",
      entityType: "tenant",
      entityId: ctx.tenant.id,
    });
  });
}

export async function removeSchoolLogo(database: Database, ctx: TenantContext): Promise<void> {
  assertAllowed(ctx, "school.settings.manage");
  await withTenant(database, scope(ctx), async (tx) => {
    const before = await readBranding(tx, ctx.tenant.id);
    if (!before.logoFileId) return;
    await markRemoved(tx, ctx, before.logoFileId, "school_logo");
    await upsert(tx, ctx, { logoFileId: null });
    await recordAudit(tx, {
      tenantId: ctx.tenant.id,
      actorUserId: ctx.userId,
      action: "school.logo_removed",
      entityType: "tenant",
      entityId: ctx.tenant.id,
    });
  });
}

/** A school's logo by its address (logos are public, like a school's sign), or null. */
export async function readSchoolLogo(
  database: Database,
  slug: string,
): Promise<{ mime: string; content: Buffer; id: string } | null> {
  const [school] = await database
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.slug, slug), eq(tenants.status, "active")));
  if (!school) return null;
  return withTenant(database, { tenantId: school.id, userId: "" }, async (tx) => {
    const { logoFileId } = await readBranding(tx, school.id);
    if (!logoFileId) return null;
    const file = await readStoredFile(tx, school.id, logoFileId, "school_logo");
    return file ? { mime: file.mime, content: file.content, id: file.id } : null;
  });
}

/** The logo bytes for documents (receipts, statements) inside a school transaction. */
/** A logo react-pdf can draw (PNG or JPEG; WebP logos are left off documents). */
export interface DocumentLogo {
  data: Buffer;
  format: "png" | "jpg";
}

export async function logoForDocuments(
  tx: Parameters<typeof readStoredFile>[0],
  tenantId: string,
): Promise<DocumentLogo | null> {
  const { logoFileId } = await readBranding(tx, tenantId);
  if (!logoFileId) return null;
  const file = await readStoredFile(tx, tenantId, logoFileId, "school_logo");
  if (!file) return null;
  if (file.mime === "image/png") return { data: file.content, format: "png" };
  if (file.mime === "image/jpeg") return { data: file.content, format: "jpg" };
  return null;
}

/** The school's logo for a receipt or statement. The logo is public, so no member is needed to read it. */
export async function getDocumentLogo(database: Database, tenantId: string): Promise<DocumentLogo | null> {
  return withTenant(database, { tenantId, userId: "" }, (tx) => logoForDocuments(tx, tenantId));
}
