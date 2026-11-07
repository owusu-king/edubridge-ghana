import "server-only";
import { DomainError } from "../../errors";
import { getSyncChanges } from "../../sync/changes";
import { SYNC_HANDLERS } from "../../sync/handlers";
import { applyOperations } from "../../sync/protocol";
import { ApiError, readJson } from "../http";
import type { ApiRoute } from "../router";

/** The sync protocol over HTTP (see src/server/sync/protocol.ts). */
export const syncRoutes: ApiRoute[] = [
  {
    method: "POST",
    path: "/schools/:school/sync",
    summary:
      "Send changes made on the device: { operations: [{ id (UUID), kind, payload, recordedAt? }] }. Kinds: attendance.register, assessment.scores, student.register. Each comes back applied, conflict or rejected; sending one again returns the same outcome.",
    auth: "school",
    handler: async ({ database, ctx, request }) => ({
      outcomes: await applyOperations(database, ctx, await readJson(request), SYNC_HANDLERS),
    }),
  },
  {
    method: "GET",
    path: "/schools/:school/sync/changes",
    summary:
      "What changed since ?cursor= (without one: a snapshot of students and classes the caller may see). Keep the returned cursor; ask again while `more` is true.",
    auth: "school",
    handler: async ({ database, ctx, url }) => {
      try {
        return await getSyncChanges(database, ctx, url.searchParams.get("cursor"));
      } catch (error) {
        if (
          error instanceof DomainError &&
          (error.code === "resync_required" || error.code === "cursor_invalid")
        )
          throw new ApiError(410, error.code, error.message);
        throw error;
      }
    },
  },
];
