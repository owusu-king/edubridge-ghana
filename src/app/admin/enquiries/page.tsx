import type { Metadata } from "next";
import { Inbox } from "lucide-react";
import { ActionButton } from "@/components/ui/action-forms";
import { Badge } from "@/components/ui/badge";
import { EmptyState, PageHeader } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { db } from "@/server/db/client";
import { listEnquiries } from "@/server/enquiries/service";
import { enquiryRoleLabel, enquirySizeLabel } from "@/lib/enquiries";
import { formatDateTime } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { requirePlatformAdmin } from "@/web/auth";
import { markHandledAction } from "./actions";

export const metadata: Metadata = { title: "Enquiries" };

/** Schools that asked for a visit on the landing page (2026-11-19), waiting ones first. */
export default async function EnquiriesPage() {
  await requirePlatformAdmin();
  const rows = await listEnquiries(db());
  const waiting = rows.filter((r) => !r.handledAt).length;
  return (
    <div className="space-y-8">
      <PageHeader
        title="Enquiries"
        description={
          rows.length
            ? `${waiting} waiting for a reply. Schools that asked for a visit on the landing page.`
            : "Schools that ask for a visit on the landing page appear here."
        }
      />
      {rows.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title="No enquiries yet"
          description="When a school fills in “Book a visit” on the landing page, its details arrive here."
        />
      ) : (
        <TableFrame>
          <Table>
            <THead>
              <tr>
                <TH>School</TH>
                <TH>Contact</TH>
                <TH>Students</TH>
                <TH>Received</TH>
                <TH>
                  <span className="sr-only">Status</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {rows.map((r) => (
                <TR key={r.id}>
                  <TD>
                    <p className="font-medium text-ink">{r.schoolName}</p>
                    <p className="text-sm text-ink-3">{r.town}</p>
                    {r.message && (
                      <p className="mt-1 max-w-md text-sm whitespace-pre-line text-ink-2">{r.message}</p>
                    )}
                  </TD>
                  <TD>
                    <p className="text-ink">
                      {r.name} <span className="text-ink-3">· {enquiryRoleLabel(r.role)}</span>
                    </p>
                    <p className="text-sm">
                      <a href={`tel:${r.phone}`} className="text-accent hover:underline">
                        {formatPhone(r.phone)}
                      </a>
                      {r.email && (
                        <>
                          {" · "}
                          <a href={`mailto:${r.email}`} className="text-accent hover:underline">
                            {r.email}
                          </a>
                        </>
                      )}
                    </p>
                  </TD>
                  <TD>{enquirySizeLabel(r.students)}</TD>
                  <TD className="whitespace-nowrap">{formatDateTime(r.createdAt, "Africa/Accra")}</TD>
                  <TD className="text-right">
                    {r.handledAt ? (
                      <span className="text-sm text-ink-3">
                        Handled{r.handledBy ? ` by ${r.handledBy}` : ""}
                      </span>
                    ) : (
                      <div className="flex items-center justify-end gap-3">
                        <Badge tone="caution">Waiting</Badge>
                        <ActionButton
                          action={markHandledAction.bind(null, r.id)}
                          label="Mark handled"
                          ariaLabel={`Mark the enquiry from ${r.schoolName} as handled`}
                        />
                      </div>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </div>
  );
}
