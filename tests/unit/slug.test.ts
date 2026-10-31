import { describe, expect, it } from "vitest";
import { isValidSlug } from "@/server/tenancy/slug";

describe("school slugs", () => {
  it("accepts lowercase alphanumeric slugs with single hyphens", () => {
    expect(isValidSlug("asante-hills")).toBe(true);
    expect(isValidSlug("school42")).toBe(true);
  });

  it("rejects malformed slugs", () => {
    for (const slug of ["", "a", "-abc", "abc-", "Abc", "a_b", "a--b", "a b", "x".repeat(49)]) {
      expect(isValidSlug(slug), slug).toBe(false);
    }
  });

  it("rejects slugs that collide with application routes", () => {
    for (const slug of ["login", "api", "schools", "design", "offline"])
      expect(isValidSlug(slug)).toBe(false);
  });
});
