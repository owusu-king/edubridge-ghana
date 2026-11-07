import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRightLeft } from "lucide-react";
import { StatusText } from "@/components/ui/badge";
import { EmptyState, PageHeader, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listTransferSchools, listTransfers, type TransferRow } from "@/server/passport/transfers";
import { listClassOptions } from "@/server/students/service";
import { formatDate } from "@/lib/format";
import { formatCedis } from "@/lib/money";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import {
  acceptTransferAction,
  approveTransferAction,
  cancelTransferAction,
  declineTransferAction,
  importRecordAction,
  requestTransferAction,
} from "./actions";
import {
  AcceptTransferDialog,
  ApproveTransferDialog,
  CancelTransferDialog,
  DeclineTransferDialog,
  ImportRecordDialog,
  RequestTransferDialog,
} from "./transfer-forms";

export const metadata: Metadata = { title: "Transfers" };

const STATUS: Record<
  TransferRow["status"],
  { label: string; tone: "positive" | "caution" | "critical" | "neutral" }
> = {
  awaiting_consent: { label: "Waiting for the family", tone: "caution" },
  awaiting_origin: { label: "Waiting for the school", tone: "caution" },
  approved: { label: "Approved: ready to enrol", tone: "positive" },
  completed: { label: "Completed", tone: "positive" },
  declined: { label: "Declined", tone: "critical" },
  cancelled: { label: "Withdrawn", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
};

/** Transfer Passport: children moving in from and out to other schools, with their records. */
export default async function TransfersPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "transfers.manage")) notFound();
  const slug = ctx.tenant.slug;
  const [rows, schools, classes] = await Promise.all([
    listTransfers(db(), ctx),
    listTransferSchools(db(), ctx.tenant.id),
    listClassOptions(db(), ctx),
  ]);
  const classOptions = classes.map((c) => ({ id: c.id, name: c.name }));
  const incoming = rows.filter((r) => r.direction === "incoming");
  const outgoing = rows.filter((r) => r.direction === "outgoing");
  const when = (d: Date) => formatDate(d, ctx.tenant.timezone);

  const table = (list: TransferRow[], label: string) => (
    <TableFrame>
      <Table>
        <THead>
          <tr>
            <TH>Child</TH>
            <TH>{label}</TH>
            <TH>Started</TH>
            <TH>Status</TH>
            <TH>
              <span className="sr-only">Actions</span>
            </TH>
          </tr>
        </THead>
        <TBody>
          {list.map((r) => (
            <TR key={r.id}>
              <TD className="text-ink">
                {r.toStudentId ? (
                  <Link
                    href={schoolPath(slug, `students/${r.toStudentId}`) as Route}
                    className="text-accent hover:underline"
                  >
                    {r.childName}
                  </Link>
                ) : r.fromStudentId ? (
                  <Link
                    href={schoolPath(slug, `students/${r.fromStudentId}`) as Route}
                    className="text-accent hover:underline"
                  >
                    {r.childName}
                  </Link>
                ) : (
                  r.childName
                )}
                <span className="block text-sm text-ink-3">
                  {r.requestedBy === "guardian" ? "Started by the family" : "Requested by the new school"}
                </span>
              </TD>
              <TD>{r.otherSchool}</TD>
              <TD className="whitespace-nowrap">{when(r.createdAt)}</TD>
              <TD>
                <StatusText tone={STATUS[r.status].tone}>{STATUS[r.status].label}</StatusText>
                {r.declineReason && <span className="block text-sm text-ink-3">{r.declineReason}</span>}
              </TD>
              <TD className="text-right">
                <div className="flex justify-end gap-2">
                  {r.direction === "outgoing" && r.status === "awaiting_origin" && (
                    <>
                      <DeclineTransferDialog
                        action={declineTransferAction.bind(null, slug, r.id)}
                        child={r.childName}
                      />
                      <ApproveTransferDialog
                        action={approveTransferAction.bind(null, slug, r.id)}
                        child={r.childName}
                        balance={
                          r.balancePesewas && r.balancePesewas > 0 ? formatCedis(r.balancePesewas) : null
                        }
                      />
                    </>
                  )}
                  {r.direction === "incoming" && r.status === "approved" && (
                    <AcceptTransferDialog
                      action={acceptTransferAction.bind(null, slug, r.id)}
                      child={r.childName}
                      classes={classOptions}
                    />
                  )}
                  {r.direction === "incoming" &&
                    ["awaiting_consent", "awaiting_origin", "approved"].includes(r.status) && (
                      <CancelTransferDialog
                        action={cancelTransferAction.bind(null, slug, r.id)}
                        child={r.childName}
                      />
                    )}
                </div>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </TableFrame>
  );

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={schoolPath(slug, "students") as Route}
          className="-ml-2 inline-flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-accent hover:bg-accent-soft"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Students
        </Link>
        <PageHeader
          title="Transfers"
          description="Children joining from or leaving for other schools, with their records. Records are signed, so the receiving school can check them; nothing moves without the family's consent."
          bordered={false}
          actions={
            <>
              <ImportRecordDialog action={importRecordAction.bind(null, slug)} classes={classOptions} />
              <RequestTransferDialog action={requestTransferAction.bind(null, slug)} schools={schools} />
            </>
          }
        />
      </div>
      <Section title="Joining this school">
        {incoming.length === 0 ? (
          <EmptyState
            icon={<ArrowRightLeft />}
            title="No children joining"
            description="When a family moves a child here, or you request a child's records, it appears here."
          />
        ) : (
          table(incoming, "From")
        )}
      </Section>
      <Section title="Leaving this school" description="Shown once the family has consented.">
        {outgoing.length === 0 ? (
          <p className="text-base text-ink-2">No children are moving to another school.</p>
        ) : (
          table(outgoing, "To")
        )}
      </Section>
    </div>
  );
}
