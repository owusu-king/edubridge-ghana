/**
 * A term of the school's own money for a demo school (2026-11-19): its bank account, cash box and Mobile Money
 * wallet; expenses through the term, most approved by the Proprietor, some waiting, one rejected and one voided;
 * cash and cheque receipts taken to the bank in deposits, the last few days' still waiting (so the finance check
 * for cash not banked has something to show); and the bank's statement, imported and matched, with its monthly
 * charges left for the Accountant to explain. Everything goes through the app's own services, so every rule holds.
 */
import { addDays } from "../../src/lib/attendance";
import { pesewasToDecimal } from "../../src/lib/money";
import type { Database } from "../../src/server/db/client";
import { importStatement } from "../../src/server/finance/bank";
import {
  createDeposit,
  decideExpense,
  listFinanceAccounts,
  listUndepositedReceipts,
  recordExpense,
  saveFinanceAccount,
  voidExpense,
} from "../../src/server/finance/service";
import type { TenantContext } from "../../src/server/tenancy/service";
import type { Random } from "./data";

interface FinanceInput {
  app: Database;
  /** The Proprietor, who approves; the Accountant, who records. */
  proprietor: TenantContext;
  bursar: TenantContext;
  rng: Random;
  today: string;
  termStart: string;
  log?: (message: string) => void;
}

type Method = "cash" | "bank_transfer" | "cheque" | "mobile_money";
interface Planned {
  spentOn: string;
  category: string;
  payee: string;
  description?: string;
  amount: number;
  account: "bank" | "cash" | "momo";
  method: Method;
  /** What happens after it is recorded. */
  outcome?: "reject" | "void" | "wait";
}

const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const isWeekday = (iso: string) => weekday(iso) >= 1 && weekday(iso) <= 5;
const nextWeekday = (iso: string) => {
  let d = addDays(iso, 1);
  while (!isWeekday(d)) d = addDays(d, 1);
  return d;
};
const tens = (n: number) => Math.round(n / 10) * 10;

/** The term's expenses, oldest first. Amounts in cedis. */
function plan(rng: Random, termStart: string, today: string): Planned[] {
  const out: Planned[] = [];
  const last = addDays(today, -1);
  for (let d = termStart; d <= last; d = addDays(d, 1)) {
    const day = weekday(d);
    const date = Number(d.slice(8, 10));
    if (day === 1)
      out.push({
        spentOn: d,
        category: "Feeding and kitchen",
        payee: rng.pick([
          "Makola wholesale (rice, oil, tomatoes)",
          "Auntie Akos Catering",
          "Kaneshie market",
        ]),
        description: "The week's food for the school kitchen",
        amount: tens(rng.normal(2600, 450)),
        account: "cash",
        method: "cash",
      });
    if (day === 3 && Number(d.slice(8, 10)) % 2 === 0)
      out.push({
        spentOn: d,
        category: "Transport and fuel",
        payee: "GOIL, Kaneshie",
        description: "Diesel for the school bus",
        amount: tens(rng.normal(780, 120)),
        account: "cash",
        method: "cash",
      });
    // Monthly bills on the first weekday from the 3rd.
    if (
      date >= 3 &&
      date <= 7 &&
      isWeekday(d) &&
      !out.some((e) => e.spentOn.slice(0, 7) === d.slice(0, 7) && e.payee === "ECG (prepaid units)")
    )
      out.push(
        {
          spentOn: d,
          category: "Utilities",
          payee: "ECG (prepaid units)",
          amount: tens(rng.normal(1750, 180)),
          account: "momo",
          method: "mobile_money",
        },
        {
          spentOn: d,
          category: "Utilities",
          payee: "Ghana Water",
          amount: tens(rng.normal(380, 40)),
          account: "bank",
          method: "bank_transfer",
        },
        {
          spentOn: d,
          category: "Internet and phone",
          payee: "Telecel Business broadband",
          amount: 650,
          account: "bank",
          method: "bank_transfer",
        },
        {
          spentOn: d,
          category: "Cleaning and sanitation",
          payee: "Melcom",
          description: "Detergents, brooms and tissue",
          amount: tens(rng.normal(310, 40)),
          account: "cash",
          method: "cash",
        },
      );
  }
  const on = (offset: number) => {
    let d = addDays(termStart, offset);
    while (!isWeekday(d)) d = addDays(d, 1);
    return d <= last ? d : null;
  };
  const oneOff = (offset: number, e: Omit<Planned, "spentOn">) => {
    const d = on(offset);
    if (d) out.push({ ...e, spentOn: d });
  };
  oneOff(4, {
    category: "Stationery and printing",
    payee: "Kingdom Books and Stationery",
    description: "Registers, chalk and markers",
    amount: 420,
    account: "cash",
    method: "cash",
  });
  oneOff(16, {
    category: "Teaching and learning materials",
    payee: "Science lab supplies, Adum",
    description: "Chemicals and glassware for JHS science",
    amount: 960,
    account: "bank",
    method: "bank_transfer",
  });
  oneOff(23, {
    category: "Repairs and maintenance",
    payee: "Kwabena Owusu, plumber",
    description: "Staff toilets: new cistern and pipes",
    amount: 1250,
    account: "bank",
    method: "bank_transfer",
  });
  oneOff(30, {
    category: "Utilities",
    payee: "ECG (prepaid units)",
    description: "Recorded twice by mistake",
    amount: 1700,
    account: "momo",
    method: "mobile_money",
    outcome: "void",
  });
  oneOff(37, {
    category: "Repairs and maintenance",
    payee: "Asamoah Events Hire",
    description: "Canopies and 200 chairs for sports day",
    amount: 1600,
    account: "cash",
    method: "cash",
    outcome: "reject",
  });
  oneOff(44, {
    category: "Stationery and printing",
    payee: "Kingdom Books and Stationery",
    description: "Printing mid-term examination papers",
    amount: 780,
    account: "cash",
    method: "cash",
  });
  // Recent, still waiting for the Proprietor.
  const recent = (days: number, e: Omit<Planned, "spentOn" | "outcome">) => {
    let d = addDays(today, -days);
    while (!isWeekday(d)) d = addDays(d, -1);
    if (d >= termStart) out.push({ ...e, spentOn: d, outcome: "wait" });
  };
  recent(3, {
    category: "Repairs and maintenance",
    payee: "Nana Yaw Roofing Works",
    description: "Roofing sheets for Block B",
    amount: 4800,
    account: "bank",
    method: "cheque",
  });
  recent(1, {
    category: "Feeding and kitchen",
    payee: "Auntie Akos Catering",
    description: "Food for the PTA meeting",
    amount: 1350,
    account: "cash",
    method: "cash",
  });
  return out.sort((a, b) => a.spentOn.localeCompare(b.spentOn));
}

export async function generateDemoFinance(input: FinanceInput) {
  const { app, proprietor, bursar, rng, today, termStart, log = () => {} } = input;
  if ((await listFinanceAccounts(app, proprietor)).length > 0)
    throw new Error("This demo school already has finance accounts; nothing was added.");

  const accounts = {
    bank: await saveFinanceAccount(app, bursar, {
      name: "GCB Bank current account",
      kind: "bank",
      institution: "GCB Bank",
      accountEnding: "4821",
    }),
    cash: await saveFinanceAccount(app, bursar, { name: "Office cash box", kind: "cash" }),
    momo: await saveFinanceAccount(app, bursar, {
      name: "MTN MoMo merchant wallet",
      kind: "mobile_money",
      institution: "MTN",
      accountEnding: "0731",
    }),
  };

  // Expenses: the Accountant records, the Proprietor decides what waits for them.
  const planned = plan(rng, termStart, today);
  const bankLines: {
    date: string;
    description: string;
    reference: string;
    debit?: number;
    credit?: number;
  }[] = [];
  let counted = 0;
  for (const e of planned) {
    const reference =
      e.method === "cheque"
        ? `CHQ ${rng.digits(6)}`
        : e.method === "bank_transfer"
          ? `TRF${rng.digits(7)}`
          : undefined;
    const { expenseId, status } = await recordExpense(app, bursar, {
      spentOn: e.spentOn,
      category: e.category,
      payee: e.payee,
      description: e.description,
      amount: String(e.amount),
      accountId: accounts[e.account],
      method: e.method,
      reference,
    });
    let approved = status === "approved";
    if (status === "pending" && e.outcome === "reject") {
      await decideExpense(app, proprietor, expenseId, {
        approve: false,
        note: "Too dear for one day. Ask two more hire companies for quotes.",
      });
    } else if (status === "pending" && e.outcome !== "wait") {
      await decideExpense(app, proprietor, expenseId, { approve: true });
      approved = true;
    }
    if (approved && e.outcome === "void") {
      await voidExpense(app, proprietor, expenseId, {
        reason: "Entered twice: the same ECG units were recorded on the 3rd.",
      });
      approved = false;
    }
    if (approved) counted++;
    if (approved && e.account === "bank")
      bankLines.push({
        date: e.method === "cheque" ? nextWeekday(e.spentOn) : e.spentOn,
        description: `${e.method === "cheque" ? "CHEQUE PAID" : "TRANSFER TO"} ${e.payee.toUpperCase()}`,
        reference: reference ?? "",
        debit: e.amount * 100,
      });
  }
  log(`${planned.length} expenses (${counted} counted, the rest waiting, rejected or voided).`);

  // Cash to bank: receipts banked a few days at a time; the last week's are still in the office.
  const receipts = await listUndepositedReceipts(app, bursar);
  const cutoff = addDays(today, -6);
  let batch: typeof receipts = [];
  let deposits = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const depositedOn = nextWeekday(batch[batch.length - 1]!.paidOn);
    if (depositedOn >= today) return;
    const slip = `GCB${rng.digits(7)}`;
    const { amountPesewas } = await createDeposit(app, bursar, {
      accountId: accounts.bank,
      depositedOn,
      slipReference: slip,
      paymentIds: batch.map((r) => r.paymentId),
    });
    bankLines.push({
      date: depositedOn,
      description: "CASH DEPOSIT, ASANTE HILLS ACADEMY",
      reference: slip,
      credit: amountPesewas,
    });
    deposits++;
    batch = [];
  };
  for (const r of receipts) {
    if (r.paidOn > cutoff) break;
    if (batch.length > 0 && Date.parse(r.paidOn) - Date.parse(batch[0]!.paidOn) >= 3 * 86_400_000)
      await flush();
    batch.push(r);
  }
  await flush();
  log(
    `${deposits} bank deposits; ${receipts.length - (await listUndepositedReceipts(app, bursar)).length} receipts banked.`,
  );

  // The bank's statement to two days ago: deposits and payments, and charges nobody has recorded yet.
  const until = addDays(today, -2);
  for (let d = termStart; d <= until; d = addDays(d, 1))
    if (d.slice(8, 10) === "28") {
      bankLines.push({ date: d, description: "ACCOUNT MAINTENANCE FEE", reference: "", debit: 2500 });
      bankLines.push({ date: d, description: "SMS ALERT CHARGES", reference: "", debit: 350 });
    }
  const rows = bankLines
    .filter((l) => l.date <= until)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((l) =>
      [
        l.date,
        `"${l.description.replace(/"/g, "'")}"`,
        l.reference,
        l.debit ? pesewasToDecimal(l.debit) : "",
        l.credit ? pesewasToDecimal(l.credit) : "",
      ].join(","),
    );
  const imported = await importStatement(app, bursar, {
    accountId: accounts.bank,
    fileName: "GCB statement.csv",
    text: ["Date,Description,Reference,Debit,Credit", ...rows].join("\n"),
  });
  log(`Bank statement: ${imported.added} lines, ${imported.matched} matched automatically.`);

  return {
    accounts: 3,
    expenses: planned.length,
    deposits,
    statementLines: imported.added,
    matched: imported.matched,
  };
}
