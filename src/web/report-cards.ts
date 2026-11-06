import "server-only";
import { after } from "next/server";
import { processReportCardBatch } from "@/server/assessment/batches";
import { db } from "@/server/db/client";
import { renderReportCardsPdf } from "@/web/pdf/report-card";

/**
 * Starts printing a batch once the response has been sent, so the person sees progress at once. If the
 * process stops part-way, the worker (npm run worker) picks the batch up again from the last class.
 */
export function printAfterResponse(tenantId: string, batchId: string): void {
  after(async () => {
    try {
      await processReportCardBatch(db(), tenantId, (cards) => renderReportCardsPdf(cards), batchId);
    } catch (error) {
      console.error("report card printing failed", error instanceof Error ? error.message : error);
    }
  });
}
