import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/cn";

const control =
  "block w-full rounded-md border border-line-strong bg-surface px-3 text-md text-ink dark:bg-subtle/60 " +
  "placeholder:text-ink-3 transition-[color,background-color,border-color,box-shadow] hover:border-ink-3/60 " +
  // Focus: one crisp 2px edge in the accent (the border plus a matching inner line), not a second outline.
  "focus-visible:border-accent focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] focus-visible:outline-hidden " +
  "disabled:cursor-not-allowed disabled:bg-subtle disabled:text-ink-3 " +
  "aria-invalid:border-critical aria-invalid:focus-visible:border-critical " +
  "aria-invalid:focus-visible:shadow-[inset_0_0_0_1px_var(--color-critical)] sm:text-base";

/*
 * A file picker in the same frame as other inputs. The browser draws its own "Choose file" button inside;
 * it fills the left of the field as a quiet segment, and the file name sits centred beside it.
 */
const fileControl =
  "block h-10 w-full cursor-pointer overflow-hidden rounded-md border border-line-strong bg-surface pr-3 " +
  "text-sm leading-[2.375rem] text-ink-3 transition-[border-color,box-shadow] hover:border-ink-3/60 dark:bg-subtle/60 " +
  "file:mr-3 file:h-full file:cursor-pointer file:border-0 file:border-r file:border-solid file:border-line " +
  "file:bg-subtle file:px-4 file:text-sm file:font-medium file:text-ink file:transition-colors hover:file:bg-line " +
  "focus-visible:border-accent focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] focus-visible:outline-hidden " +
  "disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-critical";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  const styles = props.type === "file" ? fileControl : cn(control, "h-10");
  return <input ref={ref} className={cn(styles, className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea ref={ref} className={cn(control, "min-h-20 py-2 leading-relaxed", className)} {...props} />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select
      // React applies a select's defaultValue only when it mounts, and resets a form to that after a server
      // action succeeds, so a saved choice would show the old one until a reload. A new default remounts it.
      key={props.defaultValue === undefined ? undefined : String(props.defaultValue)}
      ref={ref}
      className={cn(control, "h-10 appearance-none bg-no-repeat pr-9", className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%238a877f' stroke-width='1.5'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E\")",
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
  /** Marks the field as optional beside its label, instead of a line of help text below it. */
  optional?: boolean;
  className?: string;
}

/** Label, control, help text and error, wired together for assistive technology. */
export function Field({ label, description, error, optional = false, className, children }: FieldProps) {
  const id = useId();
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
        {optional && <span className="font-normal text-ink-3"> (optional)</span>}
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
