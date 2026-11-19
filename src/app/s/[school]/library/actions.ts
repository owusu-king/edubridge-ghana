"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import { addCopies, saveTitle, setTitleArchived, withdrawCopy } from "@/server/library/catalogue";
import {
  cancelReservation,
  findOpenLoan,
  lendCopy,
  markLost,
  renewLoan,
  reserveTitle,
  returnLoan,
  saveFineRules,
  saveLoanRules,
} from "@/server/library/loans";
import { formatCalendarDate } from "@/lib/format";
import { formatMoney } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

/** Library (R4-7). */

type Ctx = Awaited<ReturnType<typeof requireTenant>>["ctx"];
const fields = (formData: FormData) => Object.fromEntries(formData) as Record<string, unknown>;

async function run(
  slug: string,
  formData: FormData | null,
  work: (ctx: Ctx) => Promise<string>,
  ...segments: string[]
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  let message: string;
  try {
    message = await work(ctx);
  } catch (error) {
    return toFormError(error, formData ?? undefined);
  }
  revalidatePath(schoolPath(slug, "library"));
  for (const s of segments) revalidatePath(schoolPath(slug, `library/${s}`));
  return { status: "success", message };
}

/** What a return means for the person at the desk: lateness, the fine, and who the copy is now held for. */
function returned(r: Awaited<ReturnType<typeof returnLoan>>, currency: string) {
  return [
    `${r.copy} returned.`,
    r.daysLate > 0 && `${r.daysLate} ${r.daysLate === 1 ? "day" : "days"} late.`,
    r.fineMinor > 0 && `Fine of ${formatMoney(r.fineMinor, currency)} added to the student's fee account.`,
    r.heldFor && `Keep it aside: it is held for ${r.heldFor}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

export async function saveTitleAction(
  slug: string,
  titleId: string | null,
  _p: FormState,
  formData: FormData,
) {
  return run(
    slug,
    formData,
    async (ctx) => (await saveTitle(db(), ctx, fields(formData), titleId ?? undefined), "Saved."),
    ...(titleId ? [`titles/${titleId}`] : []),
  );
}

export async function setTitleArchivedAction(
  slug: string,
  titleId: string,
  archived: boolean,
  _p: FormState,
) {
  return run(
    slug,
    null,
    async (ctx) => (await setTitleArchived(db(), ctx, titleId, archived), "Saved."),
    `titles/${titleId}`,
  );
}

export async function addCopiesAction(slug: string, titleId: string, _p: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    async (ctx) => {
      const numbers = await addCopies(db(), ctx, titleId, fields(formData));
      return `Added ${numbers.join(", ")}. Write the number in each book.`;
    },
    `titles/${titleId}`,
  );
}

export async function withdrawCopyAction(
  slug: string,
  titleId: string,
  copyId: string,
  _p: FormState,
  formData: FormData,
) {
  return run(
    slug,
    formData,
    async (ctx) => (await withdrawCopy(db(), ctx, copyId, formData.get("reason")), "Withdrawn."),
    `titles/${titleId}`,
  );
}

export async function lendAction(slug: string, _p: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    async (ctx) => {
      const r = await lendCopy(db(), ctx, fields(formData));
      return `${r.title} lent to ${r.borrower}, due ${formatCalendarDate(r.dueOn)}.`;
    },
    "loans",
  );
}

export async function returnByNumberAction(slug: string, _p: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    async (ctx) =>
      returned(
        await returnLoan(db(), ctx, await findOpenLoan(db(), ctx, formData.get("copy"))),
        ctx.tenant.currencyCode,
      ),
    "loans",
  );
}

export async function returnAction(slug: string, loanId: string, _p: FormState) {
  return run(
    slug,
    null,
    async (ctx) => returned(await returnLoan(db(), ctx, loanId), ctx.tenant.currencyCode),
    "loans",
  );
}

export async function renewAction(slug: string, loanId: string, _p: FormState) {
  return run(
    slug,
    null,
    async (ctx) => `Renewed until ${formatCalendarDate(await renewLoan(db(), ctx, loanId))}.`,
    "loans",
  );
}

export async function lostAction(slug: string, loanId: string, _p: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    async (ctx) => (await markLost(db(), ctx, loanId, formData.get("reason")), "Marked lost."),
    "loans",
  );
}

export async function reserveAction(slug: string, titleId: string, _p: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    async (ctx) => (await reserveTitle(db(), ctx, titleId, formData.get("borrower")), "Added to the queue."),
    `titles/${titleId}`,
  );
}

export async function cancelReservationAction(
  slug: string,
  titleId: string,
  reservationId: string,
  _p: FormState,
) {
  return run(
    slug,
    null,
    async (ctx) => (await cancelReservation(db(), ctx, reservationId), "Cancelled."),
    `titles/${titleId}`,
  );
}

export async function saveLoanRulesAction(slug: string, _p: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    async (ctx) => (await saveLoanRules(db(), ctx, fields(formData)), "Saved."),
    "settings",
  );
}

export async function saveFineRulesAction(slug: string, _p: FormState, formData: FormData) {
  return run(
    slug,
    formData,
    async (ctx) => (await saveFineRules(db(), ctx, fields(formData)), "Saved."),
    "settings",
  );
}
