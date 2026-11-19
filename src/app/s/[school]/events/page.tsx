import type { Metadata } from "next";
import { requireTenant } from "@/web/auth";
import { EventsView } from "./event-list";

export const metadata: Metadata = { title: "Events" };

/** Coming events (EVT-01), with the school's term dates and holidays among them. */
export default async function EventsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  return <EventsView ctx={ctx} past={false} />;
}
