import "server-only";
import type { Transaction } from "../db/client";
import { auditEvents } from "../db/schema";

export interface AuditEntry {
  tenantId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

/** Records an audit event inside the caller's transaction so the event and the change commit together. */
export async function recordAudit(tx: Transaction, entry: AuditEntry): Promise<void> {
  await tx.insert(auditEvents).values({
    tenantId: entry.tenantId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ?? {},
    ipAddress: entry.ipAddress ?? null,
  });
}
