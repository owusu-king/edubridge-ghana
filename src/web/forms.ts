import "server-only";
import { ZodError } from "zod";
import { ForbiddenError } from "@/server/authz/permissions";
import { DomainError } from "@/server/errors";
import { NotPlatformAdminError } from "@/server/platform/service";

/** Result of a server-action form submission, rendered by the form with useActionState. */
export interface FormState<T = undefined> {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
  /** Submitted values echoed back after a failure, so React's post-action form reset keeps them. */
  values?: Record<string, string>;
  data?: T;
}

export const idle: FormState = { status: "idle" };

/**
 * Maps expected failures to a user-facing form state. Anything unexpected is re-thrown so it reaches
 * the error boundary and logs, rather than leaking internal messages into the form.
 */
export function toFormError(error: unknown, formData?: FormData): FormState<never> {
  return { ...describeError(error), values: formData ? echoValues(formData) : undefined };
}

/** Text fields from a submission, excluding secrets and Next.js internals. */
function echoValues(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string" || key.startsWith("$") || /password|token/i.test(key)) continue;
    // Repeated fields (checkbox groups) are joined with commas.
    values[key] = key in values ? `${values[key]},${value}` : value;
  }
  return values;
}

function describeError(error: unknown): FormState<never> {
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    return { status: "error", message: "Check the highlighted fields.", fieldErrors };
  }
  if (error instanceof DomainError) {
    return error.field
      ? { status: "error", message: error.message, fieldErrors: { [error.field]: error.message } }
      : { status: "error", message: error.message };
  }
  if (error instanceof ForbiddenError || error instanceof NotPlatformAdminError) {
    return { status: "error", message: "You do not have permission to do this." };
  }
  throw error;
}
