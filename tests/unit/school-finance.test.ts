import { describe, expect, it } from "vitest";
import {
  automaticMatch,
  parseBankStatement,
  parseStatementAmount,
  parseStatementDate,
  rankCandidates,
  statementLineKeys,
  type MatchCandidate,
} from "@/lib/school-finance";

describe("bank statement dates and amounts", () => {
  it("reads the date formats Ghanaian banks export, day first", () => {
    expect(parseStatementDate("2026-11-05")).toBe("2026-11-05");
    expect(parseStatementDate("05/11/2026")).toBe("2026-11-05");
    expect(parseStatementDate("5-11-26")).toBe("2026-11-05");
    expect(parseStatementDate("05-Nov-2026")).toBe("2026-11-05");
    expect(parseStatementDate("5 November 2026")).toBe("2026-11-05");
    expect(parseStatementDate("31/02/2026")).toBeNull();
    expect(parseStatementDate("Closing balance")).toBeNull();
  });

  it("reads signed amounts, DR and CR marks, brackets and currency", () => {
    expect(parseStatementAmount("1,200.50")).toBe(120050);
    expect(parseStatementAmount("-300")).toBe(-30000);
    expect(parseStatementAmount("(300.00)")).toBe(-30000);
    expect(parseStatementAmount("300.00 DR")).toBe(-30000);
    expect(parseStatementAmount("GHS 1,000.00 CR")).toBe(100000);
    expect(parseStatementAmount("")).toBe(0);
    expect(parseStatementAmount("12.345")).toBeNull();
    expect(parseStatementAmount("abc")).toBeNull();
  });
});

describe("reading a bank statement", () => {
  it("reads Debit and Credit columns under a header found below the bank's preamble", () => {
    const csv = [
      "GCB Bank,Statement of account",
      "Account,****4821",
      "Date,Description,Reference,Debit,Credit,Balance",
      "03/11/2026,Cash deposit,SLIP 0042,,2500.00,12500.00",
      "04/11/2026,Transfer to Kumasi Stationers,CHQ 117,450.00,,12050.00",
      "05/11/2026,SMS alert charge,,1.50,,12048.50",
      ",Closing balance,,,,12048.50",
    ].join("\n");
    const { lines, problems } = parseBankStatement(csv);
    expect(problems).toEqual([]);
    expect(lines).toEqual([
      { lineOn: "2026-11-03", description: "Cash deposit", reference: "SLIP 0042", amountPesewas: 250000 },
      {
        lineOn: "2026-11-04",
        description: "Transfer to Kumasi Stationers",
        reference: "CHQ 117",
        amountPesewas: -45000,
      },
      { lineOn: "2026-11-05", description: "SMS alert charge", reference: null, amountPesewas: -150 },
    ]);
  });

  it("reads a single signed Amount column and reports unreadable rows", () => {
    const csv =
      "Value Date,Narration,Amount\n2026-11-03,Fees transfer Ama Mensah,1000\n2026-11-04,Bad row,12,5\n";
    const { lines, problems } = parseBankStatement(csv);
    expect(lines).toHaveLength(2);
    expect(problems).toEqual([]);
    expect(parseBankStatement("no,header,here\n1,2,3").problems[0]).toMatch(/No header row/);
  });

  it("keys identical lines apart, so re-importing a file adds nothing", () => {
    const line = { lineOn: "2026-11-05", description: "Charge", reference: null, amountPesewas: -500 };
    const keys = statementLineKeys([line, line]);
    expect(keys[0]).not.toBe(keys[1]);
    expect(statementLineKeys([line, line])).toEqual(keys);
  });
});

describe("matching statement lines", () => {
  const deposit = (
    id: string,
    on: string,
    amount: number,
    reference: string | null = null,
  ): MatchCandidate => ({
    kind: "deposit",
    id,
    on,
    amountPesewas: amount,
    reference,
    label: id,
  });
  const line = {
    lineOn: "2026-11-05",
    description: "Cash deposit SLIP 0042",
    reference: null,
    amountPesewas: 250000,
  };

  it("matches the one record with the same amount and a near date", () => {
    expect(
      automaticMatch(line, [deposit("a", "2026-11-04", 250000), deposit("b", "2026-11-04", 9900)])?.id,
    ).toBe("a");
    expect(automaticMatch(line, [deposit("far", "2026-10-01", 250000)])).toBeNull();
  });

  it("leaves a choice to a person unless one reference agrees", () => {
    const two = [deposit("a", "2026-11-04", 250000), deposit("b", "2026-11-06", 250000)];
    expect(automaticMatch(line, two)).toBeNull();
    expect(rankCandidates(line, two).map((c) => c.id)).toEqual(["a", "b"]);
    const withRef = [deposit("a", "2026-11-04", 250000), deposit("b", "2026-11-06", 250000, "SLIP 0042")];
    expect(automaticMatch(line, withRef)?.id).toBe("b");
  });

  it("never matches money in with money out", () => {
    expect(automaticMatch(line, [deposit("a", "2026-11-05", -250000)])).toBeNull();
  });
});
