import { describe, expect, it } from "vitest";
import {
  accentStyleSheet,
  accentVariables,
  contrastRatio,
  darkAccentVariables,
  isAccessibleAccent,
  isHexColor,
  schoolLogoUrl,
} from "@/lib/branding";

describe("school accent colour", () => {
  it("measures contrast the WCAG way", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(contrastRatio("#ffffff", "#ffffff")).toBe(1);
    // EduBridge blue on white.
    expect(contrastRatio("#24467a", "#ffffff")).toBeGreaterThan(9);
  });

  it("accepts only colours white text stays readable on (AA, 4.5:1)", () => {
    expect(isAccessibleAccent("#24467a")).toBe(true);
    expect(isAccessibleAccent("#7a1f1f")).toBe(true);
    expect(isAccessibleAccent("#ffd400")).toBe(false); // yellow
    expect(isAccessibleAccent("#8fbc8f")).toBe(false); // pale green
    expect(isAccessibleAccent("#767676")).toBe(true); // the 4.54:1 grey
    expect(isAccessibleAccent("#777777")).toBe(false); // 4.48:1
    expect(isAccessibleAccent("blue")).toBe(false);
  });

  it("derives the hover and soft shades", () => {
    expect(accentVariables("#24467a")).toEqual({
      "--color-accent": "#24467a",
      "--color-accent-hover": "#1d3862",
      "--color-accent-soft": "#e9edf2",
    });
  });

  it("keeps the dark-theme accent readable for the darkest accepted colour", () => {
    const dark = darkAccentVariables("#000000");
    expect(contrastRatio(dark["--color-accent"]!, "#18181b")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark["--color-accent"]!, "#111113")).toBeGreaterThanOrEqual(4.5);
  });

  it("writes a style sheet only for a plain hex colour", () => {
    expect(accentStyleSheet("#24467A")).toBe(
      ":root{--color-accent:light-dark(#24467a,#a7b5ca);" +
        "--color-accent-hover:light-dark(#1d3862,#bdc8d7);" +
        "--color-accent-soft:light-dark(#e9edf2,#1a202c)}",
    );
    expect(accentStyleSheet(null)).toBe("");
    expect(accentStyleSheet("#000}body{display:none")).toBe("");
    expect(accentStyleSheet("red")).toBe("");
    expect(isHexColor("#12345g")).toBe(false);
  });

  it("gives the logo address with a cache-busting version", () => {
    expect(schoolLogoUrl("kings-road", "abc")).toBe("/logo/kings-road?v=abc");
    expect(schoolLogoUrl("kings-road", null)).toBeNull();
  });
});
