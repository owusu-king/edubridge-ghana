import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="flex flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <p className="mb-1 text-sm text-ink-3">{eyebrow}</p>}
        <h1 className="font-display text-xl font-medium tracking-tight text-ink sm:text-2xl">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-base text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Section({
  title,
  description,
  children,
  className,
  aside,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  aside?: ReactNode;
}) {
  return (
    <section className={cn("space-y-4", className)}>
      <div className="flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-md font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-ink-3">{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Key–value pairs, e.g. a record's attributes. Stacks on mobile. */
export function DescriptionList({
  items,
  stacked = false,
}: {
  items: { term: string; detail: ReactNode }[];
  /** Always stack term above detail, for narrow columns. */
  stacked?: boolean;
}) {
  return (
    <dl className="divide-y divide-line rounded-lg border border-line bg-surface shadow-raised">
      {items.map((item) => (
        <div
          key={item.term}
          className={cn("grid gap-1 px-5 py-3.5", !stacked && "sm:grid-cols-[12rem_1fr] sm:gap-6")}
        >
          <dt className="text-sm text-ink-3">{item.term}</dt>
          <dd className="text-base text-ink">{item.detail}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-line-strong px-6 py-14 text-center">
      {icon && <div className="mb-3 text-ink-3 [&_svg]:size-6">{icon}</div>}
      <p className="text-md font-medium text-ink">{title}</p>
      <p className="mt-1 max-w-sm text-base text-ink-2">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-subtle", className)} />;
}

export function Avatar({
  label,
  initials,
  size = "md",
}: {
  label: string;
  initials: string;
  size?: "sm" | "md";
}) {
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-subtle font-medium text-ink-2 ring-1 ring-line",
        size === "sm" ? "size-7 text-xs" : "size-8 text-sm",
      )}
    >
      {initials}
    </span>
  );
}
