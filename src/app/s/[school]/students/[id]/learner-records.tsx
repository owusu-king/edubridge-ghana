import { FileDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonStyles } from "@/components/ui/button";
import { Section } from "@/components/ui/layout";
import type { PriorRecordRow } from "@/server/passport/records";
import { formatDate } from "@/lib/format";

interface RecordView {
  enrolments?: { year?: string; term?: string; className?: string }[];
  reportCards?: { term?: { name?: string; yearName?: string }; overall?: { average?: number | null } }[];
  attendance?: { year?: string; term?: string; present?: number; marked?: number }[];
}

/**
 * Transfer Passport on the student page: records received from previous schools (verified or not), and
 * the signed record of this school to download.
 */
export function LearnerRecords({
  prior,
  downloadUrl,
  timezone,
}: {
  prior: PriorRecordRow[];
  /** Where to POST to issue and download this school's record; null without permission. */
  downloadUrl: string | null;
  timezone: string;
}) {
  if (!prior.length && !downloadUrl) return null;
  return (
    <Section
      title="Previous schools and records"
      description="Records received from schools this student attended before, and this school's signed record of them."
    >
      {prior.length === 0 ? (
        <p className="text-sm text-ink-3">No records from previous schools.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
          {prior.map((p) => {
            const r = p.record as RecordView;
            const terms = r.enrolments ?? [];
            const first = terms[0];
            const last = terms.at(-1);
            return (
              <li key={p.id} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-base font-medium text-ink">{p.issuerName}</p>
                  {p.verified ? (
                    <Badge tone="positive">Verified</Badge>
                  ) : (
                    <Badge tone="caution">Not verified</Badge>
                  )}
                </div>
                <p className="text-sm text-ink-3">
                  {p.source === "transfer" ? "Received by transfer" : "Imported from a file"} on{" "}
                  {formatDate(p.importedAt, timezone)} by {p.importedBy}
                  {p.issuedAt ? ` · issued ${formatDate(p.issuedAt, timezone)}` : ""}
                </p>
                {first && last && (
                  <p className="text-sm text-ink-2">
                    {first.className} ({first.term}, {first.year}) to {last.className} ({last.term},{" "}
                    {last.year})
                  </p>
                )}
                {(r.reportCards?.length ?? 0) > 0 && (
                  <details className="text-sm text-ink-2">
                    <summary className="cursor-pointer text-accent">
                      {r.reportCards!.length} published report{" "}
                      {r.reportCards!.length === 1 ? "card" : "cards"}, attendance
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {r.reportCards!.map((c, i) => (
                        <li key={i}>
                          {c.term?.name}, {c.term?.yearName}: average {c.overall?.average ?? "not graded"}
                        </li>
                      ))}
                      {(r.attendance ?? []).map((a, i) => (
                        <li key={`a${i}`}>
                          {a.term}, {a.year}: present {a.present} of {a.marked} registers
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {downloadUrl && (
        <form method="post" action={downloadUrl}>
          <button type="submit" className={buttonStyles("secondary", "sm")}>
            <FileDown aria-hidden="true" className="size-4" />
            Download signed learner record
          </button>
          <p className="mt-1 text-sm text-ink-3">
            For the family or a school not on EduBridge. Each download is recorded; anyone can check it at
            /verify.
          </p>
        </form>
      )}
    </Section>
  );
}
