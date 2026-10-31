import { describe, expect, it } from "vitest";
import { formatDate, initials, safeRedirectPath } from "@/lib/format";

describe("formatting", () => {
  it("formats dates in the school's time zone", () => {
    const lateEvening = new Date("2026-03-01T23:30:00Z");
    expect(formatDate(lateEvening, "Africa/Accra")).toBe("1 Mar 2026");
    expect(formatDate(lateEvening, "Africa/Nairobi")).toBe("2 Mar 2026");
  });

  it("derives initials from names", () => {
    expect(initials("Ama Serwaa Mensah")).toBe("AM");
    expect(initials("Kofi")).toBe("K");
    expect(initials("  ")).toBe("?");
  });

  it("only allows relative redirect targets", () => {
    expect(safeRedirectPath("/asante/members")).toBe("/asante/members");
    expect(safeRedirectPath("//evil.example")).toBe("/");
    expect(safeRedirectPath("https://evil.example")).toBe("/");
    expect(safeRedirectPath("/\\evil.example")).toBe("/");
    expect(safeRedirectPath(undefined, "/schools")).toBe("/schools");
  });
});
