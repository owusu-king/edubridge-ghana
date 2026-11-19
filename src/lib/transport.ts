/** Transport (R4-5): values and rules shared by the server, the pages and the tests. */

export const TRIP_DIRECTIONS = ["to_school", "from_school"] as const;
export type TripDirection = (typeof TRIP_DIRECTIONS)[number];

export const TRIP_DIRECTION_LABELS: Record<TripDirection, string> = {
  to_school: "Morning, to school",
  from_school: "Afternoon, home",
};

export const RIDE_DIRECTIONS = ["both", "to_school", "from_school"] as const;
export type RideDirection = (typeof RIDE_DIRECTIONS)[number];

export const RIDE_DIRECTION_LABELS: Record<RideDirection, string> = {
  both: "Both ways",
  to_school: "To school only",
  from_school: "Home only",
};

/** Whether a child assigned this way rides a trip in this direction. */
export function ridesOn(ride: RideDirection, trip: TripDirection): boolean {
  return ride === "both" || ride === trip;
}

/** The fare for a stop: its own where set, otherwise the route's; null when neither is set (TRN-02a). */
export function fareFor(routeFare: number | null, stopFare: number | null): number | null {
  return stopFare ?? routeFare;
}

/** "06:45": a time of day typed as hours and minutes. */
export const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export type TripState = "waiting" | "on_board" | "off";

export function tripState(mark: { boardedAt: Date | null; leftAt: Date | null } | undefined): TripState {
  if (!mark?.boardedAt) return "waiting";
  return mark.leftAt ? "off" : "on_board";
}

/** The direction that suits the time of day: before noon, the morning run. */
export function directionAt(hour: number): TripDirection {
  return hour < 12 ? "to_school" : "from_school";
}
