import { describe, expect, it } from "vitest";
import { csvCell, parseCsv } from "@/lib/csv";

describe("CSV", () => {
  it("parses quoted fields, escaped quotes and embedded newlines", () => {
    const text = 'Name,Note\r\n"Mensah, Ama","She said ""hi""\nthen left"\r\nKofi,\r\n\r\n';
    expect(parseCsv(text)).toEqual([
      ["Name", "Note"],
      ["Mensah, Ama", 'She said "hi"\nthen left'],
      ["Kofi", ""],
    ]);
  });

  it("strips a byte-order mark and detects semicolon separators", () => {
    expect(parseCsv("﻿First name;Surname\nAma;Owusu")).toEqual([
      ["First name", "Surname"],
      ["Ama", "Owusu"],
    ]);
  });

  it("quotes values only when needed", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('Owusu, "Ama"')).toBe('"Owusu, ""Ama"""');
  });
});
