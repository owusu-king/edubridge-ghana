import { AGE_BUCKETS } from "@/lib/dashboard";
import { formatCedis } from "@/lib/money";

/** What is owed, by how long it has been owed: one row per age, with a bar for its share. */
export function Aging({ buckets, totalPesewas }: { buckets: number[]; totalPesewas: number }) {
  return (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">Owed today by how long it has been owed</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">Owed for</th>
          <th scope="col">Amount</th>
          <th scope="col">Share</th>
        </tr>
      </thead>
      <tbody>
        {AGE_BUCKETS.map((bucket, i) => {
          const amount = buckets[i] ?? 0;
          const share = totalPesewas > 0 ? amount / totalPesewas : 0;
          return (
            <tr key={bucket.label} className="border-b border-line last:border-0">
              <th scope="row" className="w-32 py-2 pr-3 font-normal whitespace-nowrap text-ink-2">
                {bucket.label}
              </th>
              <td className="py-2 pr-3 text-right whitespace-nowrap text-ink tabular-nums">
                {formatCedis(amount)}
              </td>
              <td className="w-[45%] py-2">
                <span className="flex items-center gap-2">
                  <span aria-hidden="true" className="h-2 flex-1 rounded-full bg-subtle">
                    <span
                      className="block h-2 rounded-full bg-accent"
                      style={{ width: amount > 0 ? `max(4px, ${share * 100}%)` : "0" }}
                    />
                  </span>
                  <span className="w-10 text-right text-xs text-ink-3 tabular-nums">
                    {Math.round(share * 100)}%
                  </span>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
