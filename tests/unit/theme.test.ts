import { describe, expect, it } from "vitest";
import { explicitTheme, hintedScheme } from "@/lib/theme";

describe("theme preference", () => {
  it("keeps only an explicit light or dark choice", () => {
    expect(explicitTheme("light")).toBe("light");
    expect(explicitTheme("dark")).toBe("dark");
  });

  it("follows the system for anything else", () => {
    expect(explicitTheme(undefined)).toBeNull();
    expect(explicitTheme("system")).toBeNull();
    expect(explicitTheme('dark" onload="x')).toBeNull();
  });

  it("reads the device's setting as Chrome and Edge report it, for System", () => {
    expect(hintedScheme('"dark"')).toBe("dark");
    expect(hintedScheme('"light"')).toBe("light");
    expect(hintedScheme("dark")).toBe("dark");
    expect(hintedScheme('"no-preference"')).toBeNull();
    expect(hintedScheme('"dark" onload="x"')).toBeNull();
    expect(hintedScheme(null)).toBeNull();
  });
});
