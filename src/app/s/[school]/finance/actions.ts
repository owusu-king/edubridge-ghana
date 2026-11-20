"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/server/db/client";
import {
  importStatement,
  matchStatementLine,
  rematchAccount,
  unmatchStatementLine,
} from "@/server/finance/bank";
import {
  cancelDeposit,
  createDeposit,
  decideExpense,
  recordExpense,
  saveFinanceAccount,
  setExpenseApprovalAmount,
  setFinanceAccountStatus,
  voidExpense,
} from "@/server/finance/service";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { toFormError, type FormState } from "@/web/forms";

/** Server actions for the Finance area: accounts, cash to bank, bank statements and expenses (2026-11-18). */

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

async function run(slug: string, fn: () => Promise<unknown>, message: string, formData?: FormData) {
  try {
    await fn();
    revalidatePath(schoolPath(slug, "finance"), "layout");
    return { status: "success", message } satisfies FormState;
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function saveAccountAction(
  slug: string,
  accountId: string | null,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () =>
      saveFinanceAccount(
        db(),
        ctx,
        {
          name: text(formData, "name"),
          kind: text(formData, "kind"),
          institution: text(formData, "institution"),
          accountEnding: text(formData, "accountEnding"),
        },
        accountId ?? undefined,
      ),
    accountId ? "Account saved." : "Account added.",
    formData,
  );
}

export async function setAccountStatusAction(
  slug: string,
  accountId: string,
  status: "active" | "closed",
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () => setFinanceAccountStatus(db(), ctx, accountId, status),
    status === "closed" ? "Account closed." : "Account reopened.",
  );
}

export async function createDepositAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const deposit = await createDeposit(db(), ctx, {
      accountId: text(formData, "accountId"),
      depositedOn: text(formData, "depositedOn"),
      slipReference: text(formData, "slipReference"),
      paymentIds: formData.getAll("paymentId").filter((v): v is string => typeof v === "string"),
    });
    revalidatePath(schoolPath(slug, "finance"), "layout");
    return { status: "success", message: `Deposit ${deposit.depositNumber} recorded.` };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function cancelDepositAction(
  slug: string,
  depositId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () => cancelDeposit(db(), ctx, depositId, { reason: text(formData, "reason") }),
    "Deposit cancelled. Its receipts are waiting to be banked again.",
    formData,
  );
}

export async function recordExpenseAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const expense = await recordExpense(db(), ctx, {
      spentOn: text(formData, "spentOn"),
      category: text(formData, "category"),
      payee: text(formData, "payee"),
      description: text(formData, "description"),
      amount: text(formData, "amount"),
      accountId: text(formData, "accountId"),
      method: text(formData, "method"),
      reference: text(formData, "reference"),
    });
    revalidatePath(schoolPath(slug, "finance"), "layout");
    return {
      status: "success",
      message:
        expense.status === "pending"
          ? `Expense ${expense.expenseNumber} recorded. It waits for the Proprietor's approval.`
          : `Expense ${expense.expenseNumber} recorded.`,
    };
  } catch (error) {
    return toFormError(error, formData);
  }
}

export async function decideExpenseAction(
  slug: string,
  expenseId: string,
  approve: boolean,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () => decideExpense(db(), ctx, expenseId, { approve, note: text(formData, "note") }),
    approve ? "Expense approved." : "Expense rejected.",
    formData,
  );
}

export async function voidExpenseAction(
  slug: string,
  expenseId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () => voidExpense(db(), ctx, expenseId, { reason: text(formData, "reason") }),
    "Expense voided.",
    formData,
  );
}

export async function setApprovalAmountAction(
  slug: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () => setExpenseApprovalAmount(db(), ctx, { amount: text(formData, "amount") }),
    "Approval amount saved.",
    formData,
  );
}

/** A statement saved as CSV from the bank's online banking. */
export async function importStatementAction(
  slug: string,
  accountId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0)
    return {
      status: "error",
      message: "Choose the statement file (CSV).",
      fieldErrors: { file: "Choose a file." },
    };
  if (file.size > 2_000_000)
    return { status: "error", message: "The file is too large. Import a month at a time." };
  try {
    const result = await importStatement(db(), ctx, {
      accountId,
      fileName: file.name,
      text: await file.text(),
    });
    revalidatePath(schoolPath(slug, "finance"), "layout");
    const parts = [
      `${result.added} line${result.added === 1 ? "" : "s"} added`,
      result.skipped ? `${result.skipped} already imported` : null,
      `${result.matched} matched automatically`,
      result.problems.length
        ? `${result.problems.length} row(s) could not be read: ${result.problems[0]}`
        : null,
    ].filter(Boolean);
    return { status: "success", message: `${parts.join(", ")}.` };
  } catch (error) {
    return toFormError(error);
  }
}

export async function matchLineAction(
  slug: string,
  lineId: string,
  kind: "deposit" | "payment" | "expense",
  id: string,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(slug, () => matchStatementLine(db(), ctx, lineId, { kind, id }), "Matched.");
}

export async function explainLineAction(
  slug: string,
  lineId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(
    slug,
    () => matchStatementLine(db(), ctx, lineId, { kind: "other", note: text(formData, "note") }),
    "Explained.",
    formData,
  );
}

export async function unmatchLineAction(slug: string, lineId: string): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  return run(slug, () => unmatchStatementLine(db(), ctx, lineId), "Unmatched.");
}

export async function rematchAction(slug: string, accountId: string): Promise<FormState> {
  const { ctx } = await requireTenant(slug);
  try {
    const n = await rematchAccount(db(), ctx, accountId);
    revalidatePath(schoolPath(slug, "finance"), "layout");
    return {
      status: "success",
      message: n ? `${n} more line${n === 1 ? "" : "s"} matched.` : "Nothing new to match.",
    };
  } catch (error) {
    return toFormError(error);
  }
}
