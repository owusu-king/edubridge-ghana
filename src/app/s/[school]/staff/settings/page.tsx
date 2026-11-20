import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { ActionButton } from "@/components/ui/action-forms";
import { Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { listLeaveTypes } from "@/server/staff/leave";
import { listStaffLists, type NamedItem, type StaffListKind } from "@/server/staff/records";
import { requireTenant } from "@/web/auth";
import {
  addStaffListItemAction,
  addSuggestedLeaveTypesAction,
  saveLeaveTypeAction,
  setLeaveTypeArchivedAction,
  setStaffListItemArchivedAction,
} from "../actions";
import { AddNameForm, LeaveTypeDialog } from "../staff-controls";

export const metadata: Metadata = { title: "Staff settings" };

function NameList({ slug, kind, items }: { slug: string; kind: StaffListKind; items: NamedItem[] }) {
  if (!items.length) return <p className="text-base text-ink-3">None yet.</p>;
  return (
    <ul className="divide-y divide-line border-y border-line">
      {items.map((item) => (
        <li key={item.id} className="flex items-center justify-between gap-3 py-2.5">
          <span className={item.archived ? "text-ink-3" : "text-ink"}>
            {item.name}
            {item.archived && (
              <Badge tone="neutral" className="ml-2">
                Archived
              </Badge>
            )}
          </span>
          <ActionButton
            action={setStaffListItemArchivedAction.bind(null, slug, kind, item.id, !item.archived)}
            label={item.archived ? "Restore" : "Archive"}
            variant={item.archived ? "secondary" : "danger-outline"}
            ariaLabel={`${item.archived ? "Restore" : "Archive"} ${item.name}`}
          />
        </li>
      ))}
    </ul>
  );
}

/** Departments, positions and leave types: the school's own lists (HR-02, HR-03a). */
export default async function StaffSettingsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "staff.manage")) notFound();
  const slug = ctx.tenant.slug;
  const [lists, types] = await Promise.all([listStaffLists(db(), ctx), listLeaveTypes(db(), ctx)]);

  return (
    <div className="space-y-10">
      <Section
        title="Leave types"
        description="Days are working days a year. The suggested Ghana types follow the Labour Act 2003 minimums; check them with your own staff policy."
        aside={
          <div className="flex flex-wrap gap-2">
            <ActionButton
              action={addSuggestedLeaveTypesAction.bind(null, slug)}
              label="Add suggested types"
            />
            <LeaveTypeDialog action={saveLeaveTypeAction.bind(null, slug, null)} />
          </div>
        }
      >
        {types.length === 0 ? (
          <p className="text-base text-ink-3">No leave types yet. Add the suggested ones to start.</p>
        ) : (
          <TableFrame>
            <Table>
              <caption className="sr-only">Leave types</caption>
              <THead>
                <tr>
                  <TH>Leave</TH>
                  <TH numeric>Days a year</TH>
                  <TH>Paid</TH>
                  <TH>
                    <span className="sr-only">Actions</span>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {types.map((t) => (
                  <TR key={t.id}>
                    <TD className={t.archived ? "text-ink-3" : undefined}>
                      {t.name}
                      {t.archived && (
                        <Badge tone="neutral" className="ml-2">
                          Archived
                        </Badge>
                      )}
                    </TD>
                    <TD numeric>{t.daysPerYear ?? "No limit"}</TD>
                    <TD>{t.paid ? "Paid" : "Unpaid"}</TD>
                    <TD className="text-right">
                      <span className="inline-flex flex-wrap justify-end gap-2">
                        <LeaveTypeDialog action={saveLeaveTypeAction.bind(null, slug, t.id)} values={t} />
                        <ActionButton
                          action={setLeaveTypeArchivedAction.bind(null, slug, t.id, !t.archived)}
                          label={t.archived ? "Restore" : "Archive"}
                          variant={t.archived ? "secondary" : "danger-outline"}
                          ariaLabel={`${t.archived ? "Restore" : "Archive"} ${t.name}`}
                        />
                      </span>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
      </Section>

      <div className="grid gap-10 lg:grid-cols-2">
        <Section title="Positions" description="For example Class teacher, Accountant, Driver, Cook.">
          <AddNameForm action={addStaffListItemAction.bind(null, slug, "position")} label="New position" />
          <NameList slug={slug} kind="position" items={lists.positions} />
        </Section>
        <Section title="Departments" description="For example Teaching, Administration, Kitchen, Transport.">
          <AddNameForm
            action={addStaffListItemAction.bind(null, slug, "department")}
            label="New department"
          />
          <NameList slug={slug} kind="department" items={lists.departments} />
        </Section>
      </div>
    </div>
  );
}
