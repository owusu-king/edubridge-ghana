import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

/**
 * An optional part of a form, folded away until wanted ("Add a guardian"), so long forms stay short. Pass
 * `open` when it holds values or errors coming back from the server, so nothing typed is ever hidden.
 * Its fields stay in the form while folded, so they submit as usual.
 */
export function Disclosure({
  title,
  optional = true,
  open = false,
  children,
}: {
  title: string;
  optional?: boolean;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="group rounded-lg border border-line" open={open}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm font-medium text-ink transition-colors select-none hover:bg-subtle/60 [&::-webkit-details-marker]:hidden">
        <span>
          {title}
          {optional && <span className="font-normal text-ink-3"> (optional)</span>}
        </span>
        <ChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-ink-3 transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="space-y-4 border-t border-line p-4">{children}</div>
    </details>
  );
}
