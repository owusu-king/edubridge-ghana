import { formatCalendarDate } from "@/lib/format";
import { formatCedis } from "@/lib/money";
import { cn } from "@/lib/cn";

/** What a balance means for a family, in words parents use. */
export function balanceLabel(pesewas: number): string {
  if (pesewas > 0) return "Owed";
  if (pesewas < 0) return "In credit";
  return "Paid up";
}

/** The balance as a figure with its meaning; credits are shown as a positive amount "in credit". */
export function BalanceFigure({
  pesewas,
  size = "md",
  className,
}: {
  pesewas: number;
  size?: "md" | "lg";
  className?: string;
}) {
  return (
    <div className={cn("text-right", className)}>
      <p className="text-sm text-ink-3">{balanceLabel(pesewas)}</p>
      <p
        className={cn(
          "font-medium tabular-nums",
          size === "lg" ? "font-display text-3xl tracking-tight" : "text-lg",
          pesewas > 0 ? "text-ink" : "text-positive",
        )}
      >
        {formatCedis(Math.abs(pesewas))}
      </p>
    </div>
  );
}

export interface ChildFactsInput {
  lastPayment: { paidOn: string; amountPesewas: number } | null;
  nextDue: { dueOn: string; amountPesewas: number } | null;
  overduePesewas: number;
}

/** Last payment and payment-plan position, as short lines. */
export function ChildFacts({ child }: { child: ChildFactsInput }) {
  return (
    <ul className="space-y-1 text-sm text-ink-2">
      {child.overduePesewas > 0 && (
        <li className="font-medium text-critical">
          {formatCedis(child.overduePesewas)} overdue on the payment plan
        </li>
      )}
      {child.nextDue && (
        <li>
          Next instalment: {formatCedis(child.nextDue.amountPesewas)} by{" "}
          {formatCalendarDate(child.nextDue.dueOn)}
        </li>
      )}
      <li>
        {child.lastPayment
          ? `Last payment: ${formatCedis(child.lastPayment.amountPesewas)} on ${formatCalendarDate(child.lastPayment.paidOn)}`
          : "No payments recorded yet"}
      </li>
    </ul>
  );
}
