"use server";

import {
  discardDraft,
  draftAnnouncement,
  draftBoardReport,
  draftRemarks,
  type AnnouncementDraft,
  type BoardReportDraft,
  type RemarkDrafts,
} from "@/server/drafting/service";
import { db } from "@/server/db/client";
import { DomainError } from "@/server/errors";
import { ForbiddenError } from "@/server/authz/permissions";
import { requireTenant } from "@/web/auth";

/** Server actions for AI drafting (R5-5): each returns the draft, or a message to show in the form. */

export type DraftResult<T> = ({ ok: true } & T) | { ok: false; message: string };

async function attempt<T>(fn: () => Promise<T>): Promise<DraftResult<T>> {
  try {
    return { ok: true, ...(await fn()) };
  } catch (error) {
    if (error instanceof DomainError) return { ok: false, message: error.message };
    if (error instanceof ForbiddenError)
      return { ok: false, message: "Drafting is not available to you here." };
    throw error;
  }
}

export async function draftRemarksAction(
  slug: string,
  termId: string,
  classId: string,
  studentId: string,
): Promise<DraftResult<RemarkDrafts>> {
  const { ctx } = await requireTenant(slug);
  return attempt(() => draftRemarks(db(), ctx, { termId, classId, studentId }));
}

export async function draftAnnouncementAction(
  slug: string,
  points: string,
  audience: string,
): Promise<DraftResult<AnnouncementDraft>> {
  const { ctx } = await requireTenant(slug);
  return attempt(() => draftAnnouncement(db(), ctx, { points, audience }));
}

export async function draftBoardReportAction(
  slug: string,
  termId: string,
  campusId: string | null,
): Promise<DraftResult<BoardReportDraft>> {
  const { ctx } = await requireTenant(slug);
  return attempt(() => draftBoardReport(db(), ctx, { termId, campusId }));
}

export async function discardDraftAction(slug: string, draftId: string): Promise<void> {
  const { ctx } = await requireTenant(slug);
  await discardDraft(db(), ctx, draftId);
}
