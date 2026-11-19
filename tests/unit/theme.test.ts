import { describe, expect, it } from "vitest";
import { explicitTheme } from "@/lib/theme";

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
});
