import { describe, expect, it } from "vitest";
import { findBalanceColumns, parseBalance } from "@/server/fees/opening-balances";

describe("parseBalance", () => {
  it.each([
    ["1200", 120000],
    ["1,200.50", 120050],
    ["GH₵ 450", 45000],
    ["GHS 50.5", 5050],
    ["-300", -30000],
    ["(300)", -30000],
    ["300 CR", -30000],
    ["300 cr.", -30000],
    ["CR 300", -30000],
    ["GH₵ -75", -7500],
    ["0", 0],
  ])("reads %j as %i pesewas", (text, pesewas) => {
    expect(parseBalance(text)).toBe(pesewas);
  });

  it.each(["", "abc", "12.345", "--5", "1e3", "300 DR CR"])("rejects %j", (text) => {
    expect(parseBalance(text)).toBeNull();
  });
});

describe("findBalanceColumns", () => {
  it("finds the columns by common header names", () => {
    expect(findBalanceColumns(["Name", "Adm No", "Arrears"])).toEqual({ admission: 1, balance: 2 });
    expect(findBalanceColumns(["Admission number*", "Balance"])).toEqual({ admission: 0, balance: 1 });
  });

  it("explains what is missing", () => {
    expect(() => findBalanceColumns(["Name", "Balance"])).toThrow(/Admission number/);
  });
});
