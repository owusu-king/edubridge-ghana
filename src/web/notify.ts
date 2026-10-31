import "server-only";
import { after } from "next/server";
import { db } from "@/server/db/client";
import { dispatchPending } from "@/server/notifications/outbox";

/**
 * Delivers queued messages after the response has been sent, so a slow or failing provider never
 * blocks the user. Anything not delivered here is retried by the worker (npm run worker).
 */
export function dispatchAfterResponse(): void {
  after(async () => {
    try {
      await dispatchPending(db(), { limit: 10 });
    } catch (error) {
      console.error("notification dispatch failed", error instanceof Error ? error.message : error);
    }
  });
}
