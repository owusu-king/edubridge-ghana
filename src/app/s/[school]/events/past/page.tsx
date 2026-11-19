import type { Metadata } from "next";
import { requireTenant } from "@/web/auth";
import { EventsView } from "../event-list";

export const metadata: Metadata = { title: "Past events" };

export default async function PastEventsPage({ params }: { params: Promise<{ school: string }> }) {
  const { school } = await params;
  const { ctx } = await requireTenant(school);
  return <EventsView ctx={ctx} past />;
}
