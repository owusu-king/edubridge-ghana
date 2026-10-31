"use client";

import { Check, Copy } from "lucide-react";
import { useId, useState } from "react";

/** Read-only value with a copy button, for one-time secrets such as invitation links. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="h-10 min-w-0 flex-1 rounded-md border border-line-strong bg-subtle px-3 font-mono text-sm text-ink"
        />
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-10 items-center gap-2 rounded-md border border-line-strong bg-surface px-3 text-base font-medium text-ink shadow-raised hover:bg-subtle"
        >
          {copied ? (
            <Check aria-hidden="true" className="size-4" />
          ) : (
            <Copy aria-hidden="true" className="size-4" />
          )}
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
    </div>
  );
}
