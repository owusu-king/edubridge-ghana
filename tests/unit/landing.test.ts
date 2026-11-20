import { describe, expect, it } from "vitest";
import { introVideo } from "@/components/landing/intro-video";
import { demoSchoolSlug } from "@/server/demo/visit";
import { enquirySchema } from "@/server/enquiries/service";

describe("the landing page's settings", () => {
  it("offers the demo school only for a plain school address", () => {
    expect(demoSchoolSlug({ DEMO_SCHOOL_SLUG: "demo-academy" })).toBe("demo-academy");
    expect(demoSchoolSlug({ DEMO_SCHOOL_SLUG: "  demo-academy " })).toBe("demo-academy");
    expect(demoSchoolSlug({})).toBeNull();
    expect(demoSchoolSlug({ DEMO_SCHOOL_SLUG: "../admin" })).toBeNull();
    expect(demoSchoolSlug({ DEMO_SCHOOL_SLUG: "Demo Academy" })).toBeNull();
  });

  it("plays only a video EduBridge serves itself", () => {
    expect(introVideo({ LANDING_VIDEO: "/landing/intro.mp4" })).toEqual({
      src: "/landing/intro.mp4",
      poster: null,
    });
    expect(introVideo({ LANDING_VIDEO: "https://example.com/v.mp4" }).src).toBeNull();
    expect(introVideo({ LANDING_VIDEO: "//example.com/v.mp4" }).src).toBeNull();
    expect(introVideo({}).src).toBeNull();
  });
});

describe("book a visit", () => {
  const valid = {
    name: "Akosua Frimpong",
    role: "head",
    schoolName: "Synthetic Hills Academy",
    town: "Tamale",
    phone: "0241234567",
    email: " ",
    students: "under_150",
    message: "",
  };

  it("keeps the phone in E.164 and empty optional fields as nothing", () => {
    expect(enquirySchema.parse(valid)).toMatchObject({ phone: "+233241234567", email: null, message: null });
  });

  it("names each field that is wrong", () => {
    const result = enquirySchema.safeParse({ ...valid, email: "not an email", students: "lots" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0]).sort()).toEqual(["email", "students"]);
  });
});
