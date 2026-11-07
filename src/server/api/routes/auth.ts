import "server-only";
import { z } from "zod";
import {
  deviceNameSchema,
  deviceTokenIssuer,
  listDeviceTokens,
  revokeDeviceToken,
  revokeDeviceTokenById,
} from "../../auth/device-tokens";
import { verifyChallenge } from "../../auth/mfa";
import { signIn } from "../../auth/sign-in";
import { listUserSchools } from "../../tenancy/service";
import { ApiError, clientOf, readJson } from "../http";
import type { ApiRoute } from "../router";

const deviceRequest = z.object({ deviceName: deviceNameSchema });

const verifyRequest = z.object({
  challenge: z.string().max(128),
  code: z.string().max(40),
  deviceName: deviceNameSchema,
});

/** Sign-in for apps and devices, the device list and revocation. */
export const authRoutes: ApiRoute[] = [
  {
    method: "POST",
    path: "/auth/token",
    summary:
      "Sign in with email (or verified phone) and password; returns a device token, or a challenge when the account uses two-step verification.",
    auth: "public",
    handler: async ({ database, request }) => {
      const raw = await readJson(request, 8 * 1024);
      const { deviceName } = deviceRequest.parse(raw);
      const result = await signIn(
        database,
        raw as Parameters<typeof signIn>[1],
        clientOf(request),
        new Date(),
        deviceTokenIssuer(deviceName),
      );
      if (result.ok === true) return { token: result.token, expiresAt: result.expiresAt.toISOString() };
      if (result.ok === "mfa")
        return {
          mfaRequired: true,
          challenge: result.challengeToken,
          expiresAt: result.expiresAt.toISOString(),
        };
      if (result.reason === "throttled")
        throw new ApiError(429, "throttled", "Too many attempts. Wait 15 minutes and try again.");
      throw new ApiError(401, "invalid_credentials", "The email or password is incorrect.");
    },
  },
  {
    method: "POST",
    path: "/auth/token/verify",
    summary: "Complete a two-step sign-in with a code from the authenticator app (or a recovery code).",
    auth: "public",
    handler: async ({ database, request }) => {
      const body = verifyRequest.parse(await readJson(request, 8 * 1024));
      const result = await verifyChallenge(
        database,
        body.challenge,
        body.code,
        clientOf(request),
        new Date(),
        deviceTokenIssuer(body.deviceName),
      );
      if (!result.ok)
        throw result.reason === "expired"
          ? new ApiError(401, "challenge_expired", "Sign in again: this step has expired.")
          : new ApiError(401, "invalid_code", "That code is not valid.");
      return { token: result.session.token, expiresAt: result.session.expiresAt.toISOString() };
    },
  },
  {
    method: "GET",
    path: "/me",
    summary: "The signed-in user and the schools they can use.",
    auth: "user",
    handler: async ({ database, caller }) => ({
      user: { id: caller.user.id, name: caller.user.name, email: caller.user.email },
      schools: await listUserSchools(database, caller.user.id),
    }),
  },
  {
    method: "GET",
    path: "/auth/tokens",
    summary: "The signed-in user's devices (live tokens).",
    auth: "user",
    handler: async ({ database, caller }) => ({ devices: await listDeviceTokens(database, caller.user.id) }),
  },
  {
    method: "DELETE",
    path: "/auth/tokens/:handle",
    summary: "Revoke one of the user's devices.",
    auth: "user",
    handler: async ({ database, caller, params }) => {
      if (!(await revokeDeviceToken(database, caller.user.id, params.handle ?? "")))
        throw new ApiError(404, "not_found", "Not found.");
      return { revoked: true };
    },
  },
  {
    method: "POST",
    path: "/auth/sign-out",
    summary: "Revoke the token this request was made with.",
    auth: "user",
    handler: async ({ database, caller }) => {
      if (!caller.tokenId) throw new ApiError(400, "not_a_device", "Sign out of the web from the web.");
      await revokeDeviceTokenById(database, caller.tokenId);
      return { revoked: true };
    },
  },
];
