import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Transaction } from "../db/client";
import { storedFiles, users } from "../db/schema";
import { DomainError } from "../errors";
import type { TenantContext } from "../tenancy/service";

/**
 * Private file storage for schools (logos, student photos, student documents, payment evidence), kept in
 * PostgreSQL so it is covered by the same tenant isolation, backups and audit as the records it belongs to.
 * The type is decided from the file's own bytes (never its name or the browser's claim), and each purpose
 * has its own allowed types and size limit. Files are served only by routes that check access first.
 */

export type FilePurpose = (typeof storedFiles.$inferSelect)["purpose"];

type Kind = "png" | "jpeg" | "webp" | "pdf";
const MIME: Record<Kind, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  pdf: "application/pdf",
};

const RULES: Record<FilePurpose, { kinds: Kind[]; maxBytes: number; label: string }> = {
  school_logo: {
    kinds: ["png", "jpeg", "webp"],
    maxBytes: 300 * 1024,
    label: "a PNG, JPEG or WebP image up to 300 KB",
  },
  student_photo: {
    kinds: ["png", "jpeg", "webp"],
    maxBytes: 500 * 1024,
    label: "a PNG, JPEG or WebP image up to 500 KB",
  },
  student_document: {
    kinds: ["pdf", "png", "jpeg"],
    maxBytes: 5 * 1024 * 1024,
    label: "a PDF, PNG or JPEG file up to 5 MB",
  },
  payment_evidence: {
    kinds: ["pdf", "png", "jpeg"],
    maxBytes: 2 * 1024 * 1024,
    label: "a PDF, PNG or JPEG file up to 2 MB",
  },
  safeguarding_document: {
    kinds: ["pdf", "png", "jpeg"],
    maxBytes: 5 * 1024 * 1024,
    label: "a PDF, PNG or JPEG file up to 5 MB",
  },
  // A named collector's face, for staff at the gate (VIS-02a).
  collector_photo: {
    kinds: ["png", "jpeg", "webp"],
    maxBytes: 500 * 1024,
    label: "a PNG, JPEG or WebP image up to 500 KB",
  },
  // Contracts, certificates and similar (HR-01d).
  staff_document: {
    kinds: ["pdf", "png", "jpeg"],
    maxBytes: 5 * 1024 * 1024,
    label: "a PDF, PNG or JPEG file up to 5 MB",
  },
};

/** What the bytes are, from their signature. */
export function sniff(bytes: Buffer): Kind | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "webp";
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  return null;
}

/** Checks a file for a purpose and returns its type, or throws a message for the person. */
export function checkFile(purpose: FilePurpose, bytes: Buffer, field = "file"): { mime: string } {
  const rule = RULES[purpose];
  if (bytes.length === 0) throw new DomainError("file_missing", "Choose a file.", field);
  const kind = sniff(bytes);
  if (!kind || !rule.kinds.includes(kind) || bytes.length > rule.maxBytes)
    throw new DomainError("file_invalid", `Choose ${rule.label}.`, field);
  return { mime: MIME[kind] };
}

const safeName = (name: string) => (name.replace(/[^\w.\- ]+/g, "_").trim() || "file").slice(0, 120);

/** Stores a checked file inside the caller's tenant transaction; returns its id. */
export async function storeFile(
  tx: Transaction,
  ctx: TenantContext,
  input: { purpose: FilePurpose; ownerId: string | null; filename: string; bytes: Buffer },
): Promise<string> {
  const { mime } = checkFile(input.purpose, input.bytes);
  const [row] = await tx
    .insert(storedFiles)
    .values({
      tenantId: ctx.tenant.id,
      purpose: input.purpose,
      ownerId: input.ownerId,
      filename: safeName(input.filename),
      mime,
      sizeBytes: input.bytes.length,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      content: input.bytes,
      uploadedByUserId: ctx.userId,
    })
    .returning({ id: storedFiles.id });
  return row!.id;
}

/** A live (not removed) file of this purpose, or null. */
export async function readStoredFile(
  tx: Transaction,
  tenantId: string,
  id: string,
  purpose: FilePurpose,
): Promise<{ id: string; ownerId: string | null; filename: string; mime: string; content: Buffer } | null> {
  const [row] = await tx
    .select({
      id: storedFiles.id,
      ownerId: storedFiles.ownerId,
      filename: storedFiles.filename,
      mime: storedFiles.mime,
      content: storedFiles.content,
    })
    .from(storedFiles)
    .where(
      and(
        eq(storedFiles.tenantId, tenantId),
        eq(storedFiles.id, id),
        eq(storedFiles.purpose, purpose),
        isNull(storedFiles.removedAt),
      ),
    );
  return row ?? null;
}

export async function listFiles(tx: Transaction, tenantId: string, purpose: FilePurpose, ownerId: string) {
  return tx
    .select({
      id: storedFiles.id,
      filename: storedFiles.filename,
      mime: storedFiles.mime,
      sizeBytes: storedFiles.sizeBytes,
      uploadedAt: storedFiles.uploadedAt,
      uploadedBy: users.name,
    })
    .from(storedFiles)
    .innerJoin(users, eq(users.id, storedFiles.uploadedByUserId))
    .where(
      and(
        eq(storedFiles.tenantId, tenantId),
        eq(storedFiles.purpose, purpose),
        eq(storedFiles.ownerId, ownerId),
        isNull(storedFiles.removedAt),
      ),
    )
    .orderBy(desc(storedFiles.uploadedAt));
}

export async function markRemoved(tx: Transaction, ctx: TenantContext, id: string, purpose: FilePurpose) {
  const [row] = await tx
    .update(storedFiles)
    .set({ removedAt: new Date(), removedByUserId: ctx.userId })
    .where(
      and(
        eq(storedFiles.tenantId, ctx.tenant.id),
        eq(storedFiles.id, id),
        eq(storedFiles.purpose, purpose),
        isNull(storedFiles.removedAt),
      ),
    )
    .returning({ ownerId: storedFiles.ownerId, filename: storedFiles.filename });
  return row ?? null;
}
