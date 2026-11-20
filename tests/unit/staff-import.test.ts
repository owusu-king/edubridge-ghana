import { describe, expect, it } from "vitest";
import { autoMapStaffColumns, STAFF_TEMPLATE_HEADERS } from "@/server/imports/staff";

describe("staff import columns", () => {
  it("matches the template's own headings to every field", () => {
    const mapping = autoMapStaffColumns(STAFF_TEMPLATE_HEADERS);
    expect(Object.values(mapping).every((v) => v !== null)).toBe(true);
  });

  it("matches headings other systems use, and leaves unknown columns alone", () => {
    const mapping = autoMapStaffColumns([
      "EMPLOYEE ID",
      "Given Name",
      "Family_Name",
      "Job Title",
      "Next of Kin",
      "Salary",
    ]);
    expect(mapping).toMatchObject({
      staffNumber: 0,
      firstName: 1,
      lastName: 2,
      position: 3,
      emergencyName: 4,
      phone: null,
    });
  });
});
