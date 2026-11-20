import { BadgeCheck, TriangleAlert } from "lucide-react";

/*
 * The hero's picture of the product: the Fees overview, Mobile Money confirmed by the network and a finance check
 * on cash not yet banked, drawn with the app's
 * own type and colours rather than a screenshot, so it stays sharp, light on data and true in both themes. Every
 * name and figure is made up, and the caption says so. Hidden from screen readers, which get the caption.
 */

const RECEIPTS = [
  { no: "R-001284", name: "Esi Owusu", cls: "Basic 4", method: "MoMo", amount: "1,450.00" },
  { no: "R-001283", name: "Kwame Asante", cls: "JHS 2", method: "Cash", amount: "900.00" },
  { no: "R-001282", name: "Abena Boateng", cls: "KG 2", method: "Bank", amount: "2,100.00" },
  { no: "R-001281", name: "Yaw Darko", cls: "Basic 6", method: "MoMo", amount: "650.00" },
];

export function ProductPreview() {
  return (
    <figure className="relative">
      <div aria-hidden="true" className="relative">
        <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-overlay">
          <div className="flex h-9 items-center gap-1.5 border-b border-line bg-subtle/60 px-4">
            <span className="size-2 rounded-full bg-line-strong" />
            <span className="size-2 rounded-full bg-line-strong" />
            <span className="size-2 rounded-full bg-line-strong" />
            <span className="ml-3 text-xs text-ink-3">Fees · Second term</span>
          </div>
          <div className="space-y-5 p-5 sm:p-6">
            <dl className="grid grid-cols-3 gap-3">
              {[
                ["Billed", "412,600"],
                ["Collected", "318,240"],
                ["Owing", "94,360"],
              ].map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-xs text-ink-3">{label}</dt>
                  <dd className="mt-0.5 truncate text-base font-semibold text-ink tabular-nums sm:text-md">
                    <span className="text-sm font-normal text-ink-3">GH₵ </span>
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
            <div>
              <div className="h-1.5 overflow-hidden rounded-full bg-subtle">
                <div className="h-full w-[77%] rounded-full bg-accent" />
              </div>
              <p className="mt-1.5 text-xs text-ink-3">77% of the term&apos;s fees collected</p>
            </div>
            <div>
              <p className="text-xs font-medium text-ink-3">Today&apos;s receipts</p>
              <ul className="mt-2 divide-y divide-line border-y border-line">
                {RECEIPTS.map((r) => (
                  <li key={r.no} className="flex items-center gap-3 py-2.5 text-sm">
                    <span className="hidden w-18 shrink-0 font-mono text-xs text-ink-3 sm:block">{r.no}</span>
                    <span className="min-w-0 flex-1 truncate text-ink">
                      {r.name} <span className="text-ink-3">· {r.cls}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-xs text-ink-3">
                      {r.method}
                      {r.method === "MoMo" && <BadgeCheck className="size-3.5 text-positive" />}
                    </span>
                    <span className="w-18 shrink-0 text-right text-ink tabular-nums">{r.amount}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="absolute -bottom-28 -left-4 hidden w-72 rounded-lg border border-line bg-surface p-4 shadow-overlay sm:block lg:-left-10">
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-caution" />
            <div className="min-w-0 text-sm">
              <p className="font-medium text-ink">Cash not banked</p>
              <p className="mt-1 text-ink-2">
                GH₵ 3,420.00 in cash received on Monday is still in the office. Taken by the Accountant.
              </p>
              <p className="mt-2 text-xs text-ink-3">Finance check · held 4 days</p>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="mt-4 text-right text-xs text-ink-3 sm:mt-32">
        An example school. Every name and figure is made up.
      </figcaption>
    </figure>
  );
}
