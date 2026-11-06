import "server-only";
import { listAcademicYears } from "@/server/academics/calendar";
import { db } from "@/server/db/client";
import type { TenantContext } from "@/server/tenancy/service";

export interface TermOption {
  id: string;
  label: string;
  isCurrent: boolean;
}

/** Every term, newest year first, and the one asked for (or the current term, or the latest). */
export async function chooseTerm(
  ctx: TenantContext,
  requested: string | undefined,
): Promise<{ terms: TermOption[]; term: TermOption | null }> {
  const years = await listAcademicYears(db(), ctx);
  const terms = years.flatMap((y) =>
    [...y.terms].reverse().map((t) => ({ id: t.id, label: `${t.name}, ${y.name}`, isCurrent: t.isCurrent })),
  );
  const term = terms.find((t) => t.id === requested) ?? terms.find((t) => t.isCurrent) ?? terms[0] ?? null;
  return { terms, term };
}

/** Query string carrying the term to the next page. */
export const termQuery = (termId: string) => `?term=${encodeURIComponent(termId)}`;
