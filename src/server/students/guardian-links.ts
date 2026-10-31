import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record";
import type { Transaction } from "../db/client";
import { guardians, studentGuardians } from "../db/schema";
import { DomainError, PG_UNIQUE_VIOLATION, pgErrorCode } from "../errors";
import type { TenantContext } from "../tenancy/service";
import { normalizePhone } from "@/lib/phone";

/** Guardian linking used by both the guardians and students services (kept separate to avoid a cycle). */
export const RELATIONSHIPS = ["mother", "father", "guardian", "grandparent", "sibling", "other"] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];
export const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  mother: "Mother",
  father: "Father",
  guardian: "Guardian",
  grandparent: "Grandparent",
  sibling: "Older sibling",
  other: "Other",
};
export const MAX_GUARDIANS = 4;

const blank = (v: unknown) => (v === "" || v === null ? undefined : v);

export const contactSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(2, "Enter the guardian's full name.")
      .max(120, "Use 120 characters or fewer."),
    phone: z.preprocess(blank, z.string().optional()).transform((v, ctx) => {
      if (!v) return null;
      const phone = normalizePhone(v);
      if (!phone) {
        ctx.addIssue({ code: "custom", message: "Enter a valid phone number, e.g. 024 123 4567." });
        return z.NEVER;
      }
      return phone;
    }),
    email: z
      .preprocess(
        blank,
        z.string().trim().toLowerCase().email("Enter a valid email address.").max(254).optional(),
      )
      .transform((v) => v ?? null),
  })
  .refine((v) => v.phone || v.email, {
    message: "Enter a phone number or an email address.",
    path: ["phone"],
  });

export const addGuardianSchema = contactSchema.and(
  z.object({
    relationship: z.enum(RELATIONSHIPS, { message: "Choose a relationship." }),
    isPrimary: z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean()),
  }),
);

export type AddGuardianInput = z.infer<typeof addGuardianSchema>;

export async function setPrimaryInTx(
  tx: Transaction,
  ctx: TenantContext,
  studentId: string,
  guardianId: string,
): Promise<void> {
  await tx
    .update(studentGuardians)
    .set({ isPrimary: false })
    .where(
      and(
        eq(studentGuardians.tenantId, ctx.tenant.id),
        eq(studentGuardians.studentId, studentId),
        eq(studentGuardians.isPrimary, true),
      ),
    );
  await tx
    .update(studentGuardians)
    .set({ isPrimary: true })
    .where(and(eq(studentGuardians.studentId, studentId), eq(studentGuardians.guardianId, guardianId)));
}

export async function linkGuardianInTx(
  tx: Transaction,
  ctx: TenantContext,
  studentId: string,
  data: AddGuardianInput,
): Promise<{ guardianId: string; linkedExisting: boolean }> {
  const existingLinks = await tx
    .select({ guardianId: studentGuardians.guardianId })
    .from(studentGuardians)
    .where(and(eq(studentGuardians.tenantId, ctx.tenant.id), eq(studentGuardians.studentId, studentId)));
  if (existingLinks.length >= MAX_GUARDIANS) {
    throw new DomainError("too_many_guardians", `A student can have up to ${MAX_GUARDIANS} guardians.`);
  }
  let guardianId: string;
  let linkedExisting = false;
  const [match] = data.phone
    ? await tx
        .select({ id: guardians.id })
        .from(guardians)
        .where(and(eq(guardians.tenantId, ctx.tenant.id), eq(guardians.phone, data.phone)))
    : [];
  if (match) {
    guardianId = match.id;
    linkedExisting = true;
    if (existingLinks.some((l) => l.guardianId === guardianId)) {
      throw new DomainError("already_linked", "This guardian is already linked to the student.", "phone");
    }
  } else {
    const [created] = await tx
      .insert(guardians)
      .values({ tenantId: ctx.tenant.id, fullName: data.fullName, phone: data.phone, email: data.email })
      .returning({ id: guardians.id });
    guardianId = created!.id;
  }
  await tx
    .insert(studentGuardians)
    .values({ tenantId: ctx.tenant.id, studentId, guardianId, relationship: data.relationship });
  // The first guardian is always the primary contact.
  if (data.isPrimary || existingLinks.length === 0) await setPrimaryInTx(tx, ctx, studentId, guardianId);
  await recordAudit(tx, {
    tenantId: ctx.tenant.id,
    actorUserId: ctx.userId,
    action: "guardian.linked",
    entityType: "student",
    entityId: studentId,
    metadata: { guardianId, relationship: data.relationship, linkedExisting },
  });
  return { guardianId, linkedExisting };
}

/** Someone added the same new phone number at the same moment; a retry links to it. */
export function mapRace(error: unknown): never {
  if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
    throw new DomainError(
      "retry",
      "This phone number was just added by someone else. Please try again.",
      "phone",
    );
  }
  throw error;
}
