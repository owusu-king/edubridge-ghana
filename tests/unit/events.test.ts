import { describe, expect, it } from "vitest";
import { consentOpen, formatEventWhen, monthOf, reminderDate } from "@/lib/events";
import { consentRequestSms, eventReminderSms } from "@/lib/fee-messages";
import { smsSegments } from "@/lib/sms";

const day = (
  startsOn: string,
  endsOn = startsOn,
  startTime: string | null = null,
  endTime: string | null = null,
) => ({
  startsOn,
  endsOn,
  startTime,
  endTime,
});

describe("event dates in words", () => {
  it("say one day with its times, or the span of several days", () => {
    expect(formatEventWhen(day("2026-11-14"))).toBe("Sat, 14 Nov 2026");
    expect(formatEventWhen(day("2026-11-14", "2026-11-14", "10:00", "12:30"))).toBe(
      "Sat, 14 Nov 2026, 10:00 to 12:30",
    );
    expect(formatEventWhen(day("2026-11-14", "2026-11-14", "10:00"))).toBe("Sat, 14 Nov 2026, 10:00");
    expect(formatEventWhen(day("2027-03-01", "2027-03-05"))).toBe("Mon 1 to Fri, 5 Mar 2027");
    expect(formatEventWhen(day("2026-11-30", "2026-12-02"))).toBe("Mon, 30 Nov to Wed, 2 Dec 2026");
    expect(formatEventWhen(day("2026-12-30", "2027-01-02"))).toBe("Wed, 30 Dec 2026 to Sat, 2 Jan 2027");
  });

  it("put reminders the right number of days before, across months", () => {
    expect(reminderDate("2026-12-01", 1)).toBe("2026-11-30");
    expect(reminderDate("2027-01-03", 7)).toBe("2026-12-27");
    expect(monthOf("2026-11-14")).toEqual({ key: "2026-11", label: "November 2026" });
  });

  it("take consent answers until the end of the deadline day, never once cancelled", () => {
    expect(consentOpen("2026-11-20", "2026-11-20", false)).toBe(true);
    expect(consentOpen("2026-11-20", "2026-11-21", false)).toBe(false);
    expect(consentOpen("2026-11-20", "2026-11-10", true)).toBe(false);
  });
});

describe("event and consent SMS", () => {
  it("fit in one SMS for a usual title, and are complete without a link for reminders", () => {
    const reminder = eventReminderSms({
      schoolName: "Accra Hills Academy",
      title: "PTA meeting",
      when: formatEventWhen(day("2026-11-14", "2026-11-14", "10:00")),
      location: "the school hall",
    });
    expect(reminder).toBe(
      "Accra Hills Academy: reminder, PTA meeting: Sat, 14 Nov 2026, 10:00, the school hall.",
    );
    expect(smsSegments(reminder)).toBe(1);
    const consent = consentRequestSms({
      schoolName: "Accra Hills Academy",
      title: "Museum trip",
      deadline: formatEventWhen(day("2026-11-20")),
      link: "https://edubridge.example/p",
    });
    expect(consent).toBe(
      'Accra Hills Academy: please answer "Museum trip" for your child by Fri, 20 Nov 2026: https://edubridge.example/p',
    );
    expect(smsSegments(consent)).toBe(1);
  });
});
