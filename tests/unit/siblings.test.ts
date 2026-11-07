import { describe, expect, it } from "vitest";
import { allowed } from "@/server/authz/permissions";
import { smsCharge } from "@/server/billing/subscriptions";
import { familiesOf, ordinalPlace, orderSiblings, planSiblingDiscounts, type Sibling } from "@/lib/siblings";
import { FEATURES } from "@/lib/plan";

const kid = (
  id: string,
  dateOfBirth: string | null,
  levelSequence: number | null,
  admissionNumber = id,
): Sibling => ({
  id,
  dateOfBirth,
  levelSequence,
  admissionNumber,
});

describe("families", () => {
  it("joins children who share a guardian, directly or through a brother or sister", () => {
    const families = familiesOf([
      { studentId: "ama", guardianId: "mum" },
      { studentId: "kofi", guardianId: "mum" },
      { studentId: "kofi", guardianId: "dad" },
      { studentId: "yaw", guardianId: "dad" },
      { studentId: "esi", guardianId: "aunt" },
    ]);
    expect(families.map((f) => f.sort())).toEqual([["ama", "kofi", "yaw"]]);
  });
});

describe("the sibling discount rule", () => {
  const ama = kid("ama", "2014-03-01", 90); // eldest, Basic 4
  const kofi = kid("kofi", "2016-05-10", 70); // Basic 2
  const yaw = kid("yaw", "2018-01-20", 50); // youngest, KG 2
  const family = [kofi, yaw, ama];

  it("puts first the child the school chooses", () => {
    expect(orderSiblings(family, "eldest").map((k) => k.id)).toEqual(["ama", "kofi", "yaw"]);
    expect(orderSiblings(family, "youngest").map((k) => k.id)).toEqual(["yaw", "kofi", "ama"]);
    expect(orderSiblings(family, "highest_class").map((k) => k.id)).toEqual(["ama", "kofi", "yaw"]);
    expect(orderSiblings(family, "lowest_class").map((k) => k.id)).toEqual(["yaw", "kofi", "ama"]);
    // A missing date of birth goes last; ties fall back to admission number.
    expect(orderSiblings([kid("b", null, 1), kid("a", "2015-01-01", 1)], "eldest").map((k) => k.id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("gives the second child and later children their discounts", () => {
    expect(
      planSiblingDiscounts([family], {
        firstChild: "eldest",
        secondPercentBasisPoints: 1000,
        laterPercentBasisPoints: 1500,
      }),
    ).toEqual([
      { studentId: "kofi", place: 2, percentBasisPoints: 1000 },
      { studentId: "yaw", place: 3, percentBasisPoints: 1500 },
    ]);
    // Later children default to the second child's discount; no discount for a place means none.
    expect(
      planSiblingDiscounts([family], {
        firstChild: "youngest",
        secondPercentBasisPoints: 500,
        laterPercentBasisPoints: null,
      }),
    ).toEqual([
      { studentId: "kofi", place: 2, percentBasisPoints: 500 },
      { studentId: "ama", place: 3, percentBasisPoints: 500 },
    ]);
    expect(
      planSiblingDiscounts([family], {
        firstChild: "eldest",
        secondPercentBasisPoints: null,
        laterPercentBasisPoints: 2000,
      }),
    ).toEqual([{ studentId: "yaw", place: 3, percentBasisPoints: 2000 }]);
    expect(ordinalPlace(2)).toBe("2nd");
    expect(ordinalPlace(3)).toBe("3rd");
    expect(ordinalPlace(11)).toBe("11th");
    expect(ordinalPlace(22)).toBe("22nd");
  });
});

describe("school choices", () => {
  it("let Accountants void receipts only when the school allows it", () => {
    const bursar = { roles: ["bursar"] as const, features: [...FEATURES] };
    expect(allowed(bursar, "payments.void")).toBe(false);
    expect(allowed({ ...bursar, schoolGrants: ["payments.void"] }, "payments.void")).toBe(true);
  });

  it("charge shared sign-in codes as a share, to the nearest pesewa", () => {
    expect(smsCharge(5, 12.5)).toBe(63);
    expect(smsCharge(5, 0.33)).toBe(2);
    expect(smsCharge(null, 10)).toBeNull();
  });
});
