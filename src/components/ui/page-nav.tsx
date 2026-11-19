import Link from "next/link";
import type { ComponentProps } from "react";
import { buttonStyles } from "./button";

/** "Page 2 of 7" with Previous and Next links, under a paged list. Renders nothing for a single page. */
export function PageNav({
  label,
  page,
  pages,
  href,
}: {
  /** The navigation's name for assistive technology, e.g. "Student pages". */
  label: string;
  page: number;
  pages: number;
  href: (page: number) => ComponentProps<typeof Link>["href"];
}) {
  if (pages <= 1) return null;
  return (
    <nav aria-label={label} className="flex items-center justify-between text-sm text-ink-2">
      <span>
        Page {page} of {pages}
      </span>
      <span className="flex gap-2">
        {page > 1 && (
          <Link href={href(page - 1)} className={buttonStyles("secondary", "sm")}>
            Previous
          </Link>
        )}
        {page < pages && (
          <Link href={href(page + 1)} className={buttonStyles("secondary", "sm")}>
            Next
          </Link>
        )}
      </span>
    </nav>
  );
}
