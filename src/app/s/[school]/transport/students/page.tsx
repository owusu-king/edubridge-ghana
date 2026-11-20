import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/ui/action-forms";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listAssignableStudents, listAssignments, listStopChoices } from "@/server/transport/assignments";
import { formatMoney } from "@/lib/money";
import { RIDE_DIRECTION_LABELS } from "@/lib/transport";
import { requireTenant } from "@/web/auth";
import { assignStudentAction, endAssignmentAction } from "../actions";
import { AssignDialog } from "../transport-controls";

export const metadata: Metadata = { title: "Transport · Students" };

/** Who rides which route and stop this term (TRN-01c), with the fare billing will charge. */
export default async function TransportStudentsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "transport.view")) notFound();
  const slug = ctx.tenant.slug;
  const manage = allowed(ctx, "transport.manage");
  const [{ termId, assignments }, students, stops] = await Promise.all([
    listAssignments(db(), ctx),
    manage ? listAssignableStudents(db(), ctx) : Promise.resolve([]),
    manage ? listStopChoices(db(), ctx) : Promise.resolve([]),
  ]);

  return (
    <Section
      title="Students this term"
      description={
        termId
          ? `${assignments.length} ${assignments.length === 1 ? "student rides" : "students ride"} a school bus.`
          : "Set the current term in Settings, Calendar first."
      }
      aside={
        manage && termId && stops.length > 0 ? (
          <AssignDialog action={assignStudentAction.bind(null, slug)} students={students} stops={stops} />
        ) : undefined
      }
    >
      {manage && termId && stops.length === 0 && (
        <p className="text-base text-ink-3">Add a route and its stops first, under Routes.</p>
      )}
      {assignments.length > 0 && (
        <TableFrame>
          <Table>
            <caption className="sr-only">Students on school buses this term</caption>
            <THead>
              <tr>
                <TH>Student</TH>
                <TH>Route and stop</TH>
                <TH className="hidden md:table-cell">Rides</TH>
                <TH className="hidden text-right sm:table-cell">Fare</TH>
                {manage && (
                  <TH>
                    <span className="sr-only">Take off</span>
                  </TH>
                )}
              </tr>
            </THead>
            <TBody>
              {assignments.map((a) => (
                <TR key={a.id}>
                  <TD>
                    <span className="font-medium text-ink">{a.student}</span>
                    <span className="block text-sm text-ink-3">{a.className ?? "No class this term"}</span>
                  </TD>
                  <TD>
                    {a.route}
                    <span className="block text-sm text-ink-3">{a.stop}</span>
                  </TD>
                  <TD className="hidden md:table-cell">{RIDE_DIRECTION_LABELS[a.direction]}</TD>
                  <TD className="hidden text-right tabular-nums sm:table-cell">
                    {a.farePesewas === null ? (
                      <span className="text-ink-3">Not set</span>
                    ) : (
                      formatMoney(a.farePesewas, ctx.tenant.currencyCode)
                    )}
                  </TD>
                  {manage && (
                    <TD className="text-right">
                      <ActionButton
                        action={endAssignmentAction.bind(null, slug, a.id)}
                        label="Take off"
                        variant="danger-outline"
                        ariaLabel={`Take ${a.student} off the route`}
                      />
                    </TD>
                  )}
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </Section>
  );
}
