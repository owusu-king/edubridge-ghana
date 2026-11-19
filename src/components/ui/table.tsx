import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/** Data table. Wrap in <TableFrame> for the bordered, horizontally scrollable container. */
export function TableFrame({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("relative overflow-x-auto rounded-lg border border-line bg-surface", className)}
      {...props}
    />
  );
}

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return <table className={cn("w-full border-collapse text-left text-base", className)} {...props} />;
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b border-line", className)} {...props} />;
}

export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-line", className)} {...props} />;
}

export function TR({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("group/row transition-colors hover:bg-subtle/50", className)} {...props} />;
}

/*
 * Grouped tables: one table, one header row, and the groups as rows inside it, so columns line up all the
 * way down. A section label row (e.g. "Primary"), then a group row (e.g. a level), then its items.
 */

/** A small muted label above a run of groups. */
export function TGroupLabel({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <th
        scope="colgroup"
        colSpan={colSpan}
        className="px-5 pt-5 pb-2 text-left text-xs font-medium text-ink-3"
      >
        {children}
      </th>
    </tr>
  );
}

/** A group's own row: slim, a step quieter than the table, above the items it holds. */
export function TGroupRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <TR className={cn("bg-subtle/35 hover:bg-subtle/60", className)} {...props} />;
}

/**
 * A row's actions, kept out of sight until the row is hovered or reached by keyboard (always shown on touch
 * screens, which cannot hover). Buttons inside are neutral rather than accent, so the page is not a wall of
 * blue links.
 */
export function RowActions({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-0.5 transition-opacity",
        "group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:hover)]:opacity-0",
        // An error inside (e.g. a failed "Make current") keeps the actions in view.
        "has-[.text-critical]:opacity-100",
        "[&_button]:text-ink-2 [&_button:hover]:bg-subtle [&_button:hover]:text-ink",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function TH({
  className,
  numeric,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={cn(
        "h-9 px-4 text-sm font-medium whitespace-nowrap text-ink-3 first:pl-5 last:pr-5",
        numeric && "text-right",
        className,
      )}
      {...props}
    />
  );
}

export function TD({
  className,
  numeric,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <td
      className={cn(
        "px-4 py-3 align-middle text-ink-2 first:pl-5 last:pr-5",
        numeric && "tabular text-right",
        className,
      )}
      {...props}
    />
  );
}
