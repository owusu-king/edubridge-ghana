import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BookOpen } from "lucide-react";
import { StatusText } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listTitles } from "@/server/library/catalogue";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { saveTitleAction } from "./actions";
import { TitleDialog } from "./library-controls";

export const metadata: Metadata = { title: "Library" };

/** The catalogue (LIB-01a): search, and how many copies of each book are in. */
export default async function LibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "library.view")) notFound();
  const slug = ctx.tenant.slug;
  const q = ((await searchParams).q ?? "").slice(0, 100);
  const titles = await listTitles(db(), ctx, q);

  return (
    <Section
      title="Catalogue"
      aside={
        allowed(ctx, "library.manage") ? (
          <TitleDialog action={saveTitleAction.bind(null, slug, null)} />
        ) : undefined
      }
    >
      <form method="get" className="flex items-end gap-2" aria-label="Find a book">
        <div className="space-y-1.5">
          <label htmlFor="library-q" className="block text-sm font-medium text-ink">
            Title, author or ISBN
          </label>
          <Input id="library-q" name="q" type="search" defaultValue={q} className="w-72" />
        </div>
        <button type="submit" className={buttonStyles("secondary")}>
          Find
        </button>
      </form>
      {titles.length === 0 ? (
        q ? (
          <p className="text-base text-ink-3">No book matches “{q}”.</p>
        ) : (
          <EmptyState
            icon={<BookOpen />}
            title="No books yet"
            description="Add the library's books with how many copies of each. Each copy gets a number to write in it."
          />
        )
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Library books</caption>
            <THead>
              <tr>
                <TH>Book</TH>
                <TH className="hidden md:table-cell">Category</TH>
                <TH className="text-right">In</TH>
                <TH className="hidden text-right sm:table-cell">Out</TH>
                <TH className="hidden text-right sm:table-cell">Waiting</TH>
              </tr>
            </THead>
            <TBody>
              {titles.map((t) => (
                <TR key={t.id}>
                  <TD>
                    <Link
                      href={schoolPath(slug, `library/titles/${t.id}`) as Route}
                      className="font-medium text-ink hover:underline"
                    >
                      {t.title}
                    </Link>
                    <span className="block text-sm text-ink-3">
                      {[t.author, t.isbn && `ISBN ${t.isbn}`].filter(Boolean).join(" · ") || " "}
                    </span>
                    {t.status === "archived" && <StatusText tone="neutral">Archived</StatusText>}
                  </TD>
                  <TD className="hidden md:table-cell">{t.category ?? "—"}</TD>
                  <TD className="text-right tabular-nums">{t.copies - t.out}</TD>
                  <TD className="hidden text-right tabular-nums sm:table-cell">{t.out}</TD>
                  <TD className="hidden text-right tabular-nums sm:table-cell">{t.waiting || "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </Section>
  );
}
