/**
 * An expected business-rule failure with a stable code and a message safe to show users.
 * Unexpected failures stay plain errors and are never shown verbatim.
 */
export class DomainError<C extends string = string> extends Error {
  constructor(
    readonly code: C,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** PostgreSQL error code, unwrapping Drizzle's query error. */
export function pgErrorCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  const code = candidate.cause?.code ?? candidate.code;
  return typeof code === "string" ? code : undefined;
}

export const PG_UNIQUE_VIOLATION = "23505";
