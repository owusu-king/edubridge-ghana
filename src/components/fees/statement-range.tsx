/**
 * Downloads a statement for a date range (FIN-12). A plain form (no JavaScript): the dates go to the
 * statement address as ?from=&to= and the PDF opens.
 */
export function StatementRangeForm({ href, today }: { href: string; today: string }) {
  const input =
    "block h-10 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink focus-visible:outline-2";
  return (
    <details className="group text-sm">
      <summary className="inline-flex h-9 cursor-pointer items-center rounded-md px-3.5 font-medium text-ink-2 hover:bg-subtle hover:text-ink">
        Statement for a period
      </summary>
      <form
        action={href}
        method="get"
        target="_blank"
        className="mt-2 flex flex-wrap items-end gap-3 px-3.5 pb-1"
      >
        <label className="space-y-1">
          <span className="block text-ink-2">From</span>
          <input type="date" name="from" max={today} required className={input} />
        </label>
        <label className="space-y-1">
          <span className="block text-ink-2">To</span>
          <input type="date" name="to" max={today} defaultValue={today} required className={input} />
        </label>
        <button
          type="submit"
          className="inline-flex h-10 items-center rounded-md border border-line-strong bg-surface px-3 font-medium text-ink hover:bg-subtle"
        >
          Download
        </button>
      </form>
    </details>
  );
}
