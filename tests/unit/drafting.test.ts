import { describe, expect, it } from "vitest";
import { extractJson, fillFigures, fillNames, sameText } from "@/lib/drafting";

describe("drafting helpers (R5-5)", () => {
  it("reads the JSON in a model's reply, however it is wrapped", () => {
    expect(extractJson('["One.", "Two.", "Three."]')).toEqual(["One.", "Two.", "Three."]);
    expect(
      extractJson('Here you are:\n```json\n{"title": "Sports day", "body": "Come along."}\n```\nThanks!'),
    ).toEqual({
      title: "Sports day",
      body: "Come along.",
    });
    expect(extractJson("No JSON at all.")).toBeNull();
  });

  it("fills names and figures on our server, never inventing a missing figure", () => {
    expect(
      fillNames("{first name} works hard; { First Name } should read more.", { "first name": "Ama" }),
    ).toBe("Ama works hard; Ama should read more.");
    expect(fillNames("News from {school}.", { school: "Kpone Ridge" })).toBe("News from Kpone Ridge.");
    expect(
      fillFigures("We billed {{billed}} and collected {{ collected }} ({{rate}}).", {
        billed: "GH₵17,330.00",
        collected: "GH₵3,743.56",
      }),
    ).toBe("We billed GH₵17,330.00 and collected GH₵3,743.56 ([not available]).");
  });

  it("compares a final text with the draft, ignoring spacing", () => {
    expect(sameText("Ama  works hard.\n", "Ama works hard.")).toBe(true);
    expect(sameText("Ama works very hard.", "Ama works hard.")).toBe(false);
  });
});
