import { CircleAlert, CircleCheck, Info } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type AlertTone = "info" | "positive" | "critical";

const styles: Record<AlertTone, { box: string; Icon: typeof Info }> = {
  info: { box: "border-accent/20 bg-accent-soft text-accent", Icon: Info },
  positive: { box: "border-positive/20 bg-positive-soft text-positive", Icon: CircleCheck },
  critical: { box: "border-critical/20 bg-critical-soft text-critical", Icon: CircleAlert },
};

/** Inline message. Errors are announced immediately; other tones politely. */
export function Alert({
  tone = "info",
  children,
  className,
}: {
  tone?: AlertTone;
  children: ReactNode;
  className?: string;
}) {
  const { box, Icon } = styles[tone];
  return (
    <div
      role={tone === "critical" ? "alert" : "status"}
      className={cn("flex gap-2.5 rounded-md border px-3 py-2.5 text-sm", box, className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
