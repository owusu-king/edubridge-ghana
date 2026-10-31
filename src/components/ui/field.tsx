import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

const control =
  "block w-full rounded-md border border-line-strong bg-surface px-3 text-md text-ink shadow-raised " +
  "placeholder:text-ink-3 transition-colors hover:border-ink-3 " +
  "focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent/25 " +
  "disabled:cursor-not-allowed disabled:bg-subtle disabled:text-ink-3 " +
  "aria-invalid:border-critical sm:text-base";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(control, "h-10", className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(control, "h-10 appearance-none bg-no-repeat pr-9", className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%236b6860' stroke-width='1.5'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E\")",
        backgroundPosition: "right 0.625rem center",
        backgroundSize: "1rem",
      }}
      {...props}
    >
      {children}
    </select>
  );
});

interface FieldProps {
  label: string;
  /** Renders the control with the generated id and ARIA attributes. */
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode;
  description?: string;
  error?: string;
  className?: string;
}

/** Label, control, help text and error, wired together for assistive technology. */
export function Field({ label, description, error, className, children }: FieldProps) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {description && !error && (
        <p id={descriptionId} className="text-sm text-ink-3">
          {description}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-critical">
          {error}
        </p>
      )}
    </div>
  );
}
