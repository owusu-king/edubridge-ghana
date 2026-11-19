import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BedDouble } from "lucide-react";
import { StatusText } from "@/components/ui/badge";
import { EmptyState, Section } from "@/components/ui/layout";
import { Table, TableFrame, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { allowed } from "@/server/authz/permissions";
import { listHouses } from "@/server/boarding/houses";
import { db } from "@/server/db/client";
import { HOUSE_KIND_LABELS } from "@/lib/boarding";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import { saveHouseAction } from "./actions";
import { HouseDialog } from "./boarding-controls";

export const metadata: Metadata = { title: "Boarding" };

/** The boarding houses: beds, boarders this term, who is out, and house staff (BRD-01). */
export default async function BoardingPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "boarding.view")) notFound();
  const slug = ctx.tenant.slug;
  const houses = await listHouses(db(), ctx);

  return (
    <Section
      title="Houses"
      aside={
        allowed(ctx, "boarding.manage") ? (
          <HouseDialog action={saveHouseAction.bind(null, slug, null)} />
        ) : undefined
      }
    >
      {houses.length === 0 ? (
        <EmptyState
          icon={<BedDouble />}
          title={allowed(ctx, "boarding.manage") ? "No houses yet" : "No house to look after"}
          description={
            allowed(ctx, "boarding.manage")
              ? "Add the boarding houses, their rooms and beds, then give boarders a bed for the term."
              : "The office appoints house staff for each house."
          }
        />
      ) : (
        <TableFrame>
          <Table>
            <caption className="sr-only">Boarding houses</caption>
            <THead>
              <tr>
                <TH>House</TH>
                <TH className="text-right">Boarders</TH>
                <TH className="hidden text-right sm:table-cell">Out</TH>
                <TH className="hidden md:table-cell">House staff</TH>
              </tr>
            </THead>
            <TBody>
              {houses.map((h) => (
                <TR key={h.id}>
                  <TD>
                    <Link
                      href={schoolPath(slug, `boarding/houses/${h.id}`) as Route}
                      className="font-medium text-ink hover:underline"
                    >
                      {h.name}
                    </Link>
                    <span className="block text-sm text-ink-3">{HOUSE_KIND_LABELS[h.kind]}</span>
                    {h.status === "archived" && <StatusText tone="neutral">Archived</StatusText>}
                  </TD>
                  <TD className="text-right tabular-nums">
                    {h.boarders} <span className="text-ink-3">of {h.beds} beds</span>
                  </TD>
                  <TD className="hidden text-right tabular-nums sm:table-cell">{h.out || "—"}</TD>
                  <TD className="hidden md:table-cell">{h.staff.join(", ") || "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </Section>
  );
}
