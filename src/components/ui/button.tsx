import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-outline";
export type ButtonSize = "sm" | "md";

const base =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap select-none " +
  "transition-[background-color,border-color,color,outline-color,scale] active:scale-[0.98] " +
  "disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0";

/*
 * Primary is a flat fill in the accent; depth comes from colour, not shadow. Secondary is a hairline
 * outline on the surface, the same height as primary so rows of buttons align. Ghost is a plain text action
 * in the accent colour with a faint tint on hover, so it still reads as clickable. Danger is the filled red of
 * the final confirmation; danger-outline is a hairline red outline for the buttons that lead to one, or that
 * remove, cancel or end something directly, so they stand apart from the actions beside them.
 */
const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover",
  secondary:
    "bg-surface text-ink border border-line-strong hover:border-ink-3/60 hover:bg-subtle dark:bg-subtle/60",
  ghost: "text-accent hover:bg-accent-soft/70 hover:text-accent-hover",
  danger: "bg-critical text-white hover:bg-critical/90",
  "danger-outline":
    "bg-surface text-critical border border-critical/45 hover:border-critical/80 hover:bg-critical-soft dark:bg-subtle/60",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-9 px-3.5 text-sm",
  md: "h-10 px-4 text-base",
};

/** Shared so links can look like buttons without a wrapper component. */
export function buttonStyles(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string,
) {
  return cn(base, variants[variant], sizes[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  pending?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    pending = false,
    className,
    children,
    disabled,
    type = "button",
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonStyles(variant, size, className)}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      // Lets containers that restyle buttons (table row actions) leave destructive ones red.
      data-variant={variant}
      {...props}
    >
      {pending && <Spinner />}
      {children}
    </button>
  );
});

function Spinner() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="animate-spin">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
