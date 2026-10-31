import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { sessions, users } from "../db/schema";
import { DomainError } from "../errors";
import { hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, verifyPassword } from "./password";

export const profileSchema = z.object({
  name: z.string().trim().min(2, "Enter your full name.").max(120, "Use 120 characters or fewer."),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password.").max(PASSWORD_MAX_LENGTH),
    newPassword: z
      .string()
      .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
      .max(PASSWORD_MAX_LENGTH, `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`),
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: "Choose a password different from your current one.",
    path: ["newPassword"],
  });

export async function updateProfile(database: Database, userId: string, input: unknown): Promise<void> {
  const { name } = profileSchema.parse(input);
  await database.update(users).set({ name, updatedAt: new Date() }).where(eq(users.id, userId));
}

/** Changes the password and signs out every other session (a stolen session should not survive). */
export async function changePassword(
  database: Database,
  userId: string,
  currentSessionId: string,
  input: unknown,
): Promise<void> {
  const data = changePasswordSchema.parse(input);
  const [user] = await database
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId));
  if (!user?.passwordHash || !(await verifyPassword(data.currentPassword, user.passwordHash))) {
    throw new DomainError("password_invalid", "Your current password is incorrect.", "currentPassword");
  }
  const passwordHash = await hashPassword(data.newPassword);
  await database.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
    await tx.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, currentSessionId)));
  });
}

export async function signOutOtherSessions(
  database: Database,
  userId: string,
  currentSessionId: string,
): Promise<number> {
  const result = await database
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, currentSessionId)));
  return result.rowCount ?? 0;
}
