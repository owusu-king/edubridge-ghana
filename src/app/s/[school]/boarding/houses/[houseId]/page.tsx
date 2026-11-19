import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/ui/action-forms";
import { StatusText } from "@/components/ui/badge";
import { Section } from "@/components/ui/layout";
import { allowed } from "@/server/authz/permissions";
import { listPlaceableStudents } from "@/server/boarding/boarders";
import { getHouse, listStaffOptions } from "@/server/boarding/houses";
import { db } from "@/server/db/client";
import { fitsHouse, HOUSE_KIND_LABELS } from "@/lib/boarding";
import { formatCalendarDate } from "@/lib/format";
import { schoolPath } from "@/lib/routes";
import { requireTenant } from "@/web/auth";
import {
  addBedsAction,
  addRoomAction,
  appointStaffAction,
  archiveBedAction,
  endPlacementAction,
  endStaffAction,
  placeBoarderAction,
  saveHouseAction,
  setHouseArchivedAction,
} from "../../actions";
import { AppointStaffForm, BedsDialog, HouseDialog, PlaceDialog, RoomDialog } from "../../boarding-controls";

export const metadata: Metadata = { title: "Boarding · House" };

/** One house: rooms and who sleeps in each bed this term, and its house staff (BRD-01). */
export default async function HousePage({
  params,
}: {
  params: Promise<{ school: string; houseId: string }>;
}) {
  const { school, houseId } = await params;
  const { ctx } = await requireTenant(school);
  if (!allowed(ctx, "boarding.view")) notFound();
  const house = await getHouse(db(), ctx, houseId);
  if (!house) notFound();
  const slug = ctx.tenant.slug;
  const manage = allowed(ctx, "boarding.manage") && house.status === "active";
  const [students, members] = manage
    ? await Promise.all([listPlaceableStudents(db(), ctx), listStaffOptions(db(), ctx)])
    : [[], []];
  const freeBeds = house.rooms
    .filter((r) => r.status === "active")
    .flatMap((r) =>
      r.beds
        .filter((b) => b.status === "active" && !b.boarder)
        .map((b) => ({ id: b.id, label: `${r.name}, ${b.label}` })),
    );
  const staffIds = new Set(house.staffList.map((s) => s.membershipId));

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link
            href={schoolPath(slug, "boarding") as Route}
            className="text-sm text-ink-3 hover:text-ink hover:underline"
          >
            Houses
          </Link>
          <h2 className="font-display text-xl font-medium tracking-tight text-ink">{house.name}</h2>
          <p className="mt-1 text-base text-ink-2">
            {HOUSE_KIND_LABELS[house.kind]} · {house.boarders} of {house.beds} beds taken this term
            {house.out ? ` · ${house.out} out on exeat` : ""}
          </p>
          {house.status === "archived" && <StatusText tone="neutral">Archived</StatusText>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {manage && freeBeds.length > 0 && (
            <PlaceDialog
              action={placeBoarderAction.bind(null, slug, house.id)}
              students={students.filter((s) => fitsHouse(house.kind, s.sex))}
              beds={freeBeds}
            />
          )}
          {manage && <RoomDialog action={addRoomAction.bind(null, slug, house.id)} />}
          {manage && <HouseDialog action={saveHouseAction.bind(null, slug, house.id)} house={house} />}
          {allowed(ctx, "boarding.manage") && (
            <ActionButton
              action={setHouseArchivedAction.bind(null, slug, house.id, house.status === "active")}
              label={house.status === "active" ? "Archive" : "Restore"}
              ariaLabel={`${house.status === "active" ? "Archive" : "Restore"} ${house.name}`}
            />
          )}
        </div>
      </div>

      {allowed(ctx, "safeguarding.report") && (
        <p className="text-sm text-ink-3">
          Worried about a boarder?{" "}
          <Link
            href={schoolPath(slug, "safeguarding") as Route}
            className="text-ink-2 underline hover:text-ink"
          >
            Report a concern
          </Link>{" "}
          to the school&apos;s safeguarding leads.
        </p>
      )}

      {house.rooms.length === 0 ? (
        <p className="text-base text-ink-3">No rooms yet.</p>
      ) : (
        house.rooms.map((room) => (
          <Section
            key={room.id}
            title={room.name}
            description={`${room.beds.filter((b) => b.boarder).length} of ${room.beds.filter((b) => b.status === "active").length} beds taken`}
            aside={
              manage && room.status === "active" ? (
                <BedsDialog action={addBedsAction.bind(null, slug, house.id, room.id)} room={room.name} />
              ) : undefined
            }
          >
            <ul className="divide-y divide-line border-y border-line">
              {room.beds
                .filter((b) => b.status === "active" || b.boarder)
                .map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                    <span className="text-base text-ink">
                      <span className="inline-block w-16 text-sm text-ink-3">{b.label}</span>
                      {b.boarder ? (
                        <>
                          {b.boarder.name}
                          {b.boarder.className && (
                            <span className="text-sm text-ink-3"> · {b.boarder.className}</span>
                          )}
                        </>
                      ) : (
                        <span className="text-ink-3">Free</span>
                      )}
                    </span>
                    {manage &&
                      (b.boarder ? (
                        <ActionButton
                          action={endPlacementAction.bind(null, slug, house.id, b.boarder.assignmentId)}
                          label="Take out"
                          ariaLabel={`Take ${b.boarder.name} out of boarding`}
                        />
                      ) : (
                        <ActionButton
                          action={archiveBedAction.bind(null, slug, house.id, b.id)}
                          label="Out of use"
                          ariaLabel={`Take ${room.name}, ${b.label} out of use`}
                        />
                      ))}
                  </li>
                ))}
            </ul>
          </Section>
        ))
      )}

      <Section title="House staff" description="They see this house and sign its boarders out and in.">
        {house.staffList.length === 0 ? (
          <p className="text-base text-ink-3">No house staff yet.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {house.staffList.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="text-base text-ink">
                  {s.name}
                  <span className="block text-sm text-ink-3">
                    since {formatCalendarDate(s.since.toISOString().slice(0, 10))}
                  </span>
                </span>
                {manage && (
                  <ActionButton
                    action={endStaffAction.bind(null, slug, house.id, s.id)}
                    label="End"
                    ariaLabel={`End ${s.name} as house staff`}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {manage && (
          <AppointStaffForm
            action={appointStaffAction.bind(null, slug, house.id)}
            members={members.filter((m) => !staffIds.has(m.id))}
          />
        )}
      </Section>
    </div>
  );
}
