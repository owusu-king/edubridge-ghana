import "server-only";
import { randomBytes } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Database, Transaction } from "../db/client";
import { withUser } from "../db/context";
import { platformEvents, recordSigningKeys, users } from "../db/schema";
import { generateSigningKey } from "../passport/signing";
import { assertPlatformAdmin } from "./service";

/**
 * Platform-managed integrations (Admin, Integrations): the keys that sign learner records and the Paystack
 * status (the AI provider and its keys are in `src/server/ai/admin.ts`). Every change is recorded in
 * `platform_events`; only platform administrators can make one (enforced by row-level security as well).
 */

async function event(
  tx: Transaction,
  actorUserId: string,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await tx.insert(platformEvents).values({ actorUserId, action, metadata });
}

export interface IntegrationsView {
  signingKeys: {
    keyId: string;
    status: "active" | "retired";
    createdAt: Date;
    retiredAt: Date | null;
    createdBy: string | null;
  }[];
  /** Whether new records can be signed in production (an active platform key or an environment key). */
  signingReady: boolean;
  paystack: { testKeySet: boolean; liveKeySet: boolean; liveAllowed: boolean };
  events: { action: string; by: string | null; at: Date; metadata: Record<string, unknown> }[];
}

export async function getIntegrations(database: Database, actorUserId: string): Promise<IntegrationsView> {
  await assertPlatformAdmin(database, actorUserId);
  return withUser(database, actorUserId, async (tx) => {
    const keys = await tx
      .select({
        keyId: recordSigningKeys.keyId,
        status: recordSigningKeys.status,
        createdAt: recordSigningKeys.createdAt,
        retiredAt: recordSigningKeys.retiredAt,
        createdBy: users.name,
      })
      .from(recordSigningKeys)
      .leftJoin(users, eq(users.id, recordSigningKeys.createdByUserId))
      .orderBy(desc(recordSigningKeys.createdAt));
    const events = await tx
      .select({
        action: platformEvents.action,
        by: users.name,
        at: platformEvents.occurredAt,
        metadata: platformEvents.metadata,
      })
      .from(platformEvents)
      .leftJoin(users, eq(users.id, platformEvents.actorUserId))
      .orderBy(desc(platformEvents.occurredAt))
      .limit(30);
    return {
      signingKeys: keys,
      signingReady: keys.some((k) => k.status === "active") || Boolean(process.env.RECORD_SIGNING_KEY),
      paystack: {
        testKeySet: Boolean(process.env.PAYSTACK_TEST_SECRET_KEY),
        liveKeySet: Boolean(process.env.PAYSTACK_SECRET_KEY),
        liveAllowed: process.env.PAYSTACK_ALLOW_LIVE === "true",
      },
      events,
    };
  });
}

/**
 * Creates a new signing key and makes it the active one; the previous key is retired (it no longer signs,
 * but records it signed keep verifying). Use it to start signing in production and to rotate keys.
 */
export async function rotateSigningKey(database: Database, actorUserId: string): Promise<string> {
  await assertPlatformAdmin(database, actorUserId);
  const keyId = `k-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
  const { publicKey, privateKeySealed } = generateSigningKey();
  await withUser(database, actorUserId, async (tx) => {
    const [previous] = await tx
      .update(recordSigningKeys)
      .set({ status: "retired", retiredAt: new Date() })
      .where(eq(recordSigningKeys.status, "active"))
      .returning({ keyId: recordSigningKeys.keyId });
    await tx.insert(recordSigningKeys).values({
      keyId,
      publicKey,
      privateKeySealed,
      status: "active",
      createdByUserId: actorUserId,
    });
    await event(tx, actorUserId, "signing_key.rotated", { keyId, retired: previous?.keyId ?? null });
  });
  return keyId;
}
