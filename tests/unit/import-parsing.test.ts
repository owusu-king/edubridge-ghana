import { describe, expect, it } from "vitest";
import { autoMapColumns, parseDate, parseSex } from "@/server/imports/students";

describe("import parsing", () => {
  it("matches common register headings to fields", () => {
    const mapping = autoMapColumns([
      "Adm. No",
      "First Name",
      "SURNAME",
      "Gender",
      "D.O.B",
      "Class",
      "Parent Name",
      "Parent Contact",
      "Notes",
    ]);
    expect(mapping).toMatchObject({
      admissionNumber: 0,
      firstName: 1,
      lastName: 2,
      sex: 3,
      dateOfBirth: 4,
      className: 5,
      guardianName: 6,
      guardianPhone: 7,
      otherNames: null,
      guardianRelationship: null,
    });
  });

  it("reads sex as written in registers", () => {
    expect(["F", "female", "Girl", "m", "MALE", "boy"].map(parseSex)).toEqual([
      "female",
      "female",
      "female",
      "male",
      "male",
      "male",
    ]);
    expect(parseSex("x")).toBeNull();
  });

  it("reads day-first dates and ISO dates, rejecting impossible ones", () => {
    expect(parseDate("14/03/2018")).toBe("2018-03-14");
    expect(parseDate("4-3-2018")).toBe("2018-03-04");
    expect(parseDate("14.03.2018")).toBe("2018-03-14");
    expect(parseDate("2018-03-14")).toBe("2018-03-14");
    expect(parseDate("31/02/2018")).toBeNull();
    expect(parseDate("03/14/2018")).toBeNull();
    expect(parseDate("March 2018")).toBeNull();
  });
});
