import { describe, expect, it } from "vitest";
import { rememberedSchool, schoolSlugFromPath } from "@/web/last-school";

describe("the remembered school", () => {
  it("takes the school from a school page's path", () => {
    expect(schoolSlugFromPath("/s/kpone-ridge")).toBe("kpone-ridge");
    expect(schoolSlugFromPath("/s/kpone-ridge/fees/accounts")).toBe("kpone-ridge");
  });

  it("ignores paths outside a school and anything that is not a plain slug", () => {
    expect(schoolSlugFromPath("/account")).toBeNull();
    expect(schoolSlugFromPath("/schools")).toBeNull();
    expect(schoolSlugFromPath("/s/Bad_Slug")).toBeNull();
    expect(schoolSlugFromPath("/s/-edge")).toBeNull();
  });

  it("reads back only a plain slug from the cookie", () => {
    expect(rememberedSchool("demo-academy")).toBe("demo-academy");
    expect(rememberedSchool(undefined)).toBeNull();
    expect(rememberedSchool("x;path=/")).toBeNull();
  });
});
