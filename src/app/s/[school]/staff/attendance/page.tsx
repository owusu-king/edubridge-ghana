import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { db } from "@/server/db/client";
import { getStaffDay } from "@/server/staff/attendance";
import { formatCalendarDate, todayIn } from "@/lib/format";
import { isWeekend } from "@/lib/attendance";
import { requireTenant } from "@/web/auth";
import { saveStaffDayAction } from "../actions";
import { StaffAttendanceSheet } from "../staff-controls";

export const metadata: Metadata = { title: "Staff attendance" };

/** Staff attendance for a day (HR-04): changes apply only from the mark shown, so nobody overwrites anyone. */
export default async function StaffAttendancePage({
  params,
  searchParams,
}: {
  params: Promise<{ school: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const [{ school }, search] = await Promise.all([params, searchParams]);
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "staff.attendance")) notFound();
  const today = todayIn(ctx.tenant.timezone);
  const date =
    search.date && /^\d{4}-\d{2}-\d{2}$/.test(search.date) && search.date <= today ? search.date : today;
  const day = await getStaffDay(db(), ctx, date);
  const slug = ctx.tenant.slug;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">{formatCalendarDate(date)}</h2>
          <p className="text-sm text-ink-3">
            {day.holiday
              ? `School holiday: ${day.holiday}.`
              : isWeekend(date)
                ? "A weekend day."
                : "Approved leave is shown and cannot be marked otherwise."}
          </p>
        </div>
        <form method="get" className="flex items-end gap-2" aria-label="Choose a day">
          <label htmlFor="staff-day" className="sr-only">
            Day
          </label>
          <Input id="staff-day" name="date" type="date" max={today} defaultValue={date} className="w-44" />
          <Button type="submit" variant="secondary">
            Open
          </Button>
        </form>
      </div>
      {day.rows.length === 0 ? (
        <EmptyState
          icon={<CalendarCheck />}
          title="No staff working on this day"
          description="Staff appear here from the day they started until the day they left."
        />
      ) : (
        <StaffAttendanceSheet
          key={date}
          date={date}
          rows={day.rows}
          save={saveStaffDayAction.bind(null, slug)}
        />
      )}
    </div>
  );
}
