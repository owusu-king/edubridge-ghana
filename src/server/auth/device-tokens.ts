import "server-only";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Database, Queryable } from "../db/client";
import { deviceTokens, users } from "../db/schema";
import { DEVICE_TOKEN_LIFETIME_MS } from "./policy";
import type { ClientInfo, SessionUser } from "./sessions";
import { generateToken, hashToken } from "./tokens";

/**
 * Device tokens for `/api/v1` (see the `device_tokens` table). The prefix tells them apart from web
 * session tokens, which the API does not accept as bearer tokens.
 */
export const DEVICE_TOKEN_PREFIX = "ebd_";
const RENEW_THRESHOLD_MS = DEVICE_TOKEN_LIFETIME_MS / 2;
/** last_used_at is updated at most this often, so reads do not write on every request. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export const deviceNameSchema = z
  .string({ message: "Name this device, e.g. “Office laptop”." })
  .trim()
  .min(1, "Name this device, e.g. “Office laptop”.")
  .max(80, "Use 80 characters or fewer.");

export interface IssuedDeviceToken {
  id: string;
  token: string;
  expiresAt: Date;
}

/** Issues a token for a user who has just signed in (password and, if they have one, the second step). */
export function deviceTokenIssuer(name: string) {
  return async (
    database: Database,
    userId: string,
    client: ClientInfo = {},
    now = new Date(),
  ): Promise<IssuedDeviceToken> => {
    const token = `${DEVICE_TOKEN_PREFIX}${generateToken()}`;
    const id = hashToken(token);
    const expiresAt = new Date(now.getTime() + DEVICE_TOKEN_LIFETIME_MS);
    await database.insert(deviceTokens).values({
      id,
      userId,
      name: deviceNameSchema.parse(name),
      expiresAt,
      userAgent: client.userAgent?.slice(0, 512) ?? null,
      ipAddress: client.ipAddress ?? null,
    });
    return { id, token, expiresAt };
  };
}

export interface ValidatedDeviceToken {
  tokenId: string;
  user: SessionUser;
}

/** The token's user, or null when it is unknown, revoked, expired or the user is no longer active. */
export async function validateDeviceToken(
  database: Database,
  token: string,
  now = new Date(),
): Promise<ValidatedDeviceToken | null> {
  if (!token.startsWith(DEVICE_TOKEN_PREFIX) || token.length > 128) return null;
  const id = hashToken(token);
  const [row] = await database
    .select({
      expiresAt: deviceTokens.expiresAt,
      lastUsedAt: deviceTokens.lastUsedAt,
      user: { id: users.id, email: users.email, name: users.name },
    })
    .from(deviceTokens)
    .innerJoin(users, eq(users.id, deviceTokens.userId))
    .where(
      and(
        eq(deviceTokens.id, id),
        isNull(deviceTokens.revokedAt),
        gt(deviceTokens.expiresAt, now),
        eq(users.status, "active"),
      ),
    )
    .limit(1);
  if (!row) return null;
  const renew = row.expiresAt.getTime() - now.getTime() < RENEW_THRESHOLD_MS;
  const touch = !row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > TOUCH_INTERVAL_MS;
  if (renew || touch)
    await database
      .update(deviceTokens)
      .set({
        lastUsedAt: now,
        ...(renew ? { expiresAt: new Date(now.getTime() + DEVICE_TOKEN_LIFETIME_MS) } : {}),
      })
      .where(eq(deviceTokens.id, id));
  return { tokenId: id, user: row.user };
}

export interface DeviceTokenRow {
  /** A public handle: the first 12 characters of the stored hash (never the token). */
  handle: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date;
  userAgent: string | null;
}

const handleOf = (id: string) => id.slice(0, 12);

/** The user's live device tokens, newest first. */
export async function listDeviceTokens(
  database: Database,
  userId: string,
  now = new Date(),
): Promise<DeviceTokenRow[]> {
  const rows = await database
    .select({
      id: deviceTokens.id,
      name: deviceTokens.name,
      createdAt: deviceTokens.createdAt,
      lastUsedAt: deviceTokens.lastUsedAt,
      expiresAt: deviceTokens.expiresAt,
      userAgent: deviceTokens.userAgent,
    })
    .from(deviceTokens)
    .where(
      and(eq(deviceTokens.userId, userId), isNull(deviceTokens.revokedAt), gt(deviceTokens.expiresAt, now)),
    )
    .orderBy(desc(deviceTokens.createdAt));
  return rows.map(({ id, ...r }) => ({ handle: handleOf(id), ...r }));
}

/** Revokes one of the user's tokens by its handle (or the full id). Returns whether one was revoked. */
export async function revokeDeviceToken(
  database: Database,
  userId: string,
  handle: string,
): Promise<boolean> {
  if (!/^[0-9a-f]{12,64}$/.test(handle)) return false;
  const live = await database
    .select({ id: deviceTokens.id })
    .from(deviceTokens)
    .where(and(eq(deviceTokens.userId, userId), isNull(deviceTokens.revokedAt)));
  const match = live.filter((t) => t.id.startsWith(handle));
  if (match.length !== 1) return false;
  await database.update(deviceTokens).set({ revokedAt: new Date() }).where(eq(deviceTokens.id, match[0]!.id));
  return true;
}

/** Revokes the token a request was made with (signing out of the API on that device). */
export async function revokeDeviceTokenById(database: Database, tokenId: string): Promise<void> {
  await database
    .update(deviceTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(deviceTokens.id, tokenId), isNull(deviceTokens.revokedAt)));
}

/** Revokes every device token of a user (password changed or reset). */
export async function revokeAllDeviceTokens(database: Queryable, userId: string): Promise<void> {
  await database
    .update(deviceTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(deviceTokens.userId, userId), isNull(deviceTokens.revokedAt)));
}
