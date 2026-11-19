/**
 * A demo school's data for every module beyond students, fees, attendance and marks (generate.ts): staff and
 * leave, staff attendance, payroll, safeguarding, visitors and pickup, transport, inventory, library, boarding,
 * the timetable, announcements, events and consent, admissions, early-warning reviews and support plans, and
 * the finance checks. Everything goes through the app's own services as the person who would do it, so the
 * data obeys the same rules (permissions, ledger, audit). Made-up names only.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  createApplication,
  makeOffer,
  moveApplication,
  recordAssessment,
} from "../../src/server/admissions/service";
import {
  addRoom,
  appointHouseStaff,
  getHouse,
  listStaffOptions,
  saveHouse,
  setBoardingFeeItem,
} from "../../src/server/boarding/houses";
import { placeBoarder, signInBoarder, signOutBoarder, listExeats } from "../../src/server/boarding/boarders";
import type { Database } from "../../src/server/db/client";
import { levelSubjects, libraryLoans, payments } from "../../src/server/db/schema";
import { getEarlyWarning, reviewIndicator } from "../../src/server/early-warning/indicators";
import { openSupportPlan } from "../../src/server/early-warning/plans";
import { createConsentForm, recordPaperAnswer } from "../../src/server/events/consent";
import { createEvent } from "../../src/server/events/events";
import { billTerm } from "../../src/server/fees/ledger";
import { recordPayment, voidPayment } from "../../src/server/fees/payments";
import { requestRefund } from "../../src/server/fees/refunds";
import { createFeeItem, setFeeItemDetails } from "../../src/server/fees/structure";
import { addAsset, changeAsset } from "../../src/server/inventory/assets";
import { reportMaintenance, updateMaintenance } from "../../src/server/inventory/maintenance";
import {
  createPurchaseRequest,
  decidePurchaseRequest,
  getPurchaseRequest,
  receivePurchaseRequest,
} from "../../src/server/inventory/purchases";
import { recordMovement, saveStockItem } from "../../src/server/inventory/stock";
import { saveSupplier } from "../../src/server/inventory/suppliers";
import { addCopies, getTitle, saveTitle } from "../../src/server/library/catalogue";
import {
  findOpenLoan,
  lendCopy,
  listBorrowerOptions,
  returnLoan,
  saveFineRules,
  saveLoanRules,
} from "../../src/server/library/loans";
import { postAnnouncement } from "../../src/server/messages/announcements";
import {
  addAdjustment,
  addSuggestedComponents,
  approvePayroll,
  listPayComponents,
  preparePayroll,
  setSalary,
} from "../../src/server/payroll/service";
import {
  addCaseEntry,
  appointLead,
  assignCaseLead,
  listCases,
  reportConcern,
  setCaseStatus,
} from "../../src/server/safeguarding/service";
import { saveStaffDay } from "../../src/server/staff/attendance";
import {
  addSuggestedLeaveTypes,
  decideLeave,
  listLeaveTypes,
  requestLeave,
} from "../../src/server/staff/leave";
import { addStaffListItem, createStaff, linkStaffMember } from "../../src/server/staff/records";
import { setGuardianFlags } from "../../src/server/students/profile";
import { savePeriod, setLesson } from "../../src/server/timetable/service";
import { assignStudent } from "../../src/server/transport/assignments";
import {
  setFares,
  saveRoute,
  saveStop,
  saveVehicle,
  setTransportFeeItem,
} from "../../src/server/transport/setup";
import { getTrip, markBoarded, markLeft } from "../../src/server/transport/trips";
import { addCollector, refusePickup, releaseStudent } from "../../src/server/visitors/pickup";
import { signInVisitor, signOutVisitor } from "../../src/server/visitors/visits";
import type { TenantContext } from "../../src/server/tenancy/service";
import { addDays } from "../../src/lib/attendance";
import { pesewasToInput } from "../../src/lib/money";
import { BOYS, GIRLS, SURNAMES, STAFF, type Random } from "./data";

export interface DemoStudent {
  id: string;
  firstName: string;
  lastName: string;
  sex: "female" | "male";
  classId: string;
  guardianId: string;
  guardianName: string;
  phone: string | null;
}

export interface ModuleDataInput {
  owner: Database;
  app: Database;
  tenantId: string;
  rng: Random;
  today: string;
  isSchoolDay: (date: string) => boolean;
  term: { id: string; startsOn: string; endsOn: string };
  campusId: string;
  roster: DemoStudent[];
  /** Level name to class id, youngest first. */
  classIds: Map<string, string>;
  levelIdOf: (level: string) => string;
  featuredClass: string;
  people: {
    proprietor: { userId: string; membershipId: string };
    head: { userId: string; membershipId: string };
    admin: { userId: string; membershipId: string };
    bursar: { userId: string; membershipId: string };
    /** Class teachers by level, with the featured class's teacher. */
    teachers: { level: string; userId: string; membershipId: string; name: string }[];
  };
  ctxOf: (userId: string) => Promise<TenantContext>;
  /** Saves a level's fees for the current term with extra items (keeps the usual items). */
  saveLevelFeesWith: (level: string, extra: Record<string, string>) => Promise<void>;
  /** Runs fn as the owner role inside the school (row-level security still applies). */
  asTenant: <T>(fn: (tx: Parameters<Parameters<Database["transaction"]>[0]>[0]) => Promise<T>) => Promise<T>;
  log: (message: string) => void;
}

const month = (iso: string, back: number) => {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 7);
};

/** Returns how many of this term's receipts the finance checks added (new) and voided. */
export async function generateModuleData(
  input: ModuleDataInput,
): Promise<{ paymentsAdded: number; paymentsVoided: number }> {
  const { app, rng, today, term, roster, classIds, people, log } = input;
  const proprietor = await input.ctxOf(people.proprietor.userId);
  const head = await input.ctxOf(people.head.userId);
  const admin = await input.ctxOf(people.admin.userId);
  const bursar = await input.ctxOf(people.bursar.userId);
  const featuredTeacher = people.teachers.find((t) => input.classIds.get(t.level) === input.featuredClass)!;
  const teacher = await input.ctxOf(featuredTeacher.userId);
  const schoolDaysBack = (count: number) => {
    const days: string[] = [];
    for (let d = addDays(today, -1); days.length < count && d >= term.startsOn; d = addDays(d, -1))
      if (input.isSchoolDay(d)) days.unshift(d);
    return days;
  };
  const studentsIn = (classId: string) => roster.filter((s) => s.classId === classId);
  const levels = [...classIds.keys()];
  const phone = () => `${rng.pick(["024", "054", "020", "027", "055"])}${rng.digits(7)}`;

  // ---- Staff and HR: a record for every member, and the support staff without accounts.
  const departments = {
    teaching: await addStaffListItem(app, proprietor, "department", { name: "Teaching" }),
    office: await addStaffListItem(app, proprietor, "department", { name: "Administration" }),
    support: await addStaffListItem(app, proprietor, "department", { name: "Support services" }),
  };
  const position = async (name: string) => addStaffListItem(app, proprietor, "position", { name });
  const positions = {
    head: await position("Head teacher"),
    teacher: await position("Class teacher"),
    accountant: await position("Accountant"),
    administrator: await position("Administrator"),
    driver: await position("Driver"),
    cook: await position("Cook"),
    security: await position("Security officer"),
    cleaner: await position("Cleaner"),
    librarian: await position("Librarian"),
  };
  type StaffSeed = {
    name: string;
    position: string;
    department: string;
    basic: number;
    membershipId?: string;
    sex: "female" | "male";
  };
  const seeds: StaffSeed[] = [
    {
      name: STAFF.head,
      position: positions.head,
      department: departments.teaching,
      basic: 6200,
      membershipId: people.head.membershipId,
      sex: "male",
    },
    {
      name: STAFF.admin,
      position: positions.administrator,
      department: departments.office,
      basic: 3400,
      membershipId: people.admin.membershipId,
      sex: "female",
    },
    {
      name: STAFF.bursar,
      position: positions.accountant,
      department: departments.office,
      basic: 4300,
      membershipId: people.bursar.membershipId,
      sex: "female",
    },
    ...people.teachers.map((t, i) => ({
      name: t.name,
      position: positions.teacher,
      department: departments.teaching,
      basic: 2800 + (i % 4) * 150,
      membershipId: t.membershipId,
      sex: (["Solomon", "Peter", "Albert", "Stephen", "Hayford", "Martin", "Cyril"].includes(
        t.name.split(" ")[0]!,
      )
        ? "male"
        : "female") as "female" | "male",
    })),
    {
      name: "Kwesi Appiah",
      position: positions.driver,
      department: departments.support,
      basic: 1900,
      sex: "male",
    },
    {
      name: "Yaw Ntim",
      position: positions.driver,
      department: departments.support,
      basic: 1900,
      sex: "male",
    },
    {
      name: "Comfort Larbi",
      position: positions.cook,
      department: departments.support,
      basic: 1600,
      sex: "female",
    },
    {
      name: "Ibrahim Seidu",
      position: positions.security,
      department: departments.support,
      basic: 1700,
      sex: "male",
    },
    {
      name: "Mohammed Alhassan",
      position: positions.security,
      department: departments.support,
      basic: 1700,
      sex: "male",
    },
    {
      name: "Esther Quartey",
      position: positions.cleaner,
      department: departments.support,
      basic: 1500,
      sex: "female",
    },
    {
      name: "Benjamin Asiedu",
      position: positions.librarian,
      department: departments.office,
      basic: 2600,
      sex: "male",
    },
  ];
  const staffIds: { id: string; seed: StaffSeed }[] = [];
  for (const seed of seeds) {
    const [firstName, ...rest] = seed.name.split(" ");
    const id = await createStaff(app, proprietor, {
      firstName,
      lastName: rest.join(" "),
      sex: seed.sex,
      phone: phone(),
      employmentType: seed.membershipId ? "permanent" : rng.chance(0.5) ? "permanent" : "contract",
      departmentId: seed.department,
      positionId: seed.position,
      campusId: input.campusId,
      startedOn: addDays(`${Number(today.slice(0, 4)) - rng.int(1, 9)}-09-01`, rng.int(0, 20)),
    });
    if (seed.membershipId) await linkStaffMember(app, proprietor, id, { membershipId: seed.membershipId });
    staffIds.push({ id, seed });
  }

  // Leave: one approved spell last week, one waiting for a decision, one sick day decided.
  await addSuggestedLeaveTypes(app, proprietor);
  const leaveTypes = await listLeaveTypes(app, proprietor);
  const typeId = (name: string) => leaveTypes.find((t) => t.name === name)?.id ?? leaveTypes[0]!.id;
  const lastWeek = schoolDaysBack(7);
  const onLeave = new Map<string, Set<string>>();
  const teacherStaff = staffIds.filter((s) => s.seed.position === positions.teacher);
  if (lastWeek.length >= 4) {
    const who = teacherStaff[Math.min(2, teacherStaff.length - 1)]!;
    const days = lastWeek.slice(1, 3);
    const asked = await requestLeave(app, head, {
      staffId: who.id,
      leaveTypeId: typeId("Sick leave"),
      startsOn: days[0],
      endsOn: days[1],
      reason: "Malaria; doctor's note given",
    });
    // Recorded by the Head teacher for someone else, it is approved at once; otherwise decide it.
    if (asked.status === "pending") await decideLeave(app, proprietor, asked.id, { approve: true });
    onLeave.set(who.id, new Set(days));
  }
  const nextMonday = (() => {
    let d = addDays(today, 14);
    while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
    return d;
  })();
  await requestLeave(app, teacher, {
    leaveTypeId: typeId("Annual leave"),
    startsOn: nextMonday,
    endsOn: addDays(nextMonday, 2),
    reason: "Family wedding in Kumasi",
  });
  const support = staffIds.find((s) => s.seed.position === positions.cook)!;
  const asked = await requestLeave(app, head, {
    staffId: support.id,
    leaveTypeId: typeId("Compassionate leave"),
    startsOn: addDays(nextMonday, 7),
    endsOn: addDays(nextMonday, 8),
    reason: "Funeral of a relative",
  });
  void asked;

  // Staff attendance for the last ten school days.
  for (const day of schoolDaysBack(10)) {
    await saveStaffDay(app, head, {
      date: day,
      marks: staffIds
        .filter((s) => !onLeave.get(s.id)?.has(day))
        .map((s) => ({
          staffId: s.id,
          status: rng.chance(0.9) ? "present" : rng.chance(0.7) ? "late" : "absent",
          version: 0,
        })),
    });
  }
  log(`${staffIds.length} staff records, leave and staff attendance.`);

  // ---- Payroll: salaries from three months ago, the last two months approved, this month prepared.
  await addSuggestedComponents(app, bursar);
  const components = await listPayComponents(app, bursar);
  const comp = (name: string) => components.find((c) => c.name === name)!.id;
  for (const s of staffIds) {
    await setSalary(app, bursar, s.id, {
      effectiveMonth: month(today, 3),
      basic: String(s.seed.basic),
      components: [
        { componentId: comp("Transport allowance"), value: s.seed.basic >= 2500 ? "250" : "150" },
        ...(s.seed.position === positions.head || s.seed.position === positions.accountant
          ? [{ componentId: comp("Responsibility allowance"), value: "400" }]
          : []),
        { componentId: comp("SSNIT (employee)"), value: "5.5" },
        { componentId: comp("SSNIT (employer)"), value: "13" },
        { componentId: comp("Income tax (PAYE)"), value: String(Math.round(s.seed.basic * 0.08)) },
        { componentId: comp("Welfare dues"), value: "20" },
      ],
    });
  }
  for (const back of [2, 1]) {
    const m = month(today, back);
    if (back === 1)
      await addAdjustment(app, bursar, {
        staffId: staffIds.find((s) => s.seed.position === positions.driver)!.id,
        month: m,
        kind: "earning",
        description: "Saturday excursion driving",
        amount: "150",
      });
    const run = await preparePayroll(app, bursar, { month: m });
    await approvePayroll(app, proprietor, run.runId);
  }
  await preparePayroll(app, bursar, { month: month(today, 0) });
  log("Payroll: two months approved, this month prepared.");

  // ---- Safeguarding: the Head teacher is the lead; two concerns, one closed.
  await appointLead(app, proprietor, people.head.membershipId);
  const lead = await input.ctxOf(people.head.userId);
  const featured = studentsIn(input.featuredClass);
  await reportConcern(app, teacher, {
    studentId: featured[3 % featured.length]!.id,
    category: "neglect",
    description: "Has come to school without lunch most days this week and said there was no food at home.",
    occurredOn: addDays(today, -3),
    location: "Classroom",
  });
  await reportConcern(app, teacher, {
    studentId: featured[7 % featured.length]!.id,
    category: "bullying",
    description: "Older pupils took his snack money at break twice this week; he was upset afterwards.",
    occurredOn: addDays(today, -9),
    location: "Playground",
  });
  const cases = await listCases(app, lead);
  for (const [i, c] of cases.entries()) {
    await assignCaseLead(app, lead, c.id, people.head.membershipId);
    await addCaseEntry(app, lead, c.id, {
      kind: "action",
      body:
        i === 0
          ? "Meet the family and the school nurse"
          : "Speak with the pupils involved and their class teachers",
      dueOn: addDays(today, 5),
    });
    await addCaseEntry(app, lead, c.id, {
      kind: "family_contact",
      body: "Called the mother; meeting agreed.",
    });
  }
  const older = cases.find((c) => c.reference === "SG0002") ?? cases[cases.length - 1]!;
  await setCaseStatus(app, lead, older.id, {
    status: "closed",
    note: "Resolved with both families; the pupils apologised and break duty was moved.",
  });
  log(`Safeguarding: ${cases.length} cases, one closed.`);

  // ---- Visitors on site today, and pickups at the end of the day.
  if (input.isSchoolDay(today)) {
    const visits = [
      {
        fullName: "Yaw Boakye",
        organisation: "Ghana Education Service",
        purpose: "official",
        host: people.head.membershipId,
      },
      { fullName: "Akosua Frimpong", purpose: "meeting", host: people.bursar.membershipId },
      { fullName: "Kojo Mensah", organisation: "Melcom Stationery", purpose: "delivery" },
      { fullName: "Grace Nyarko", purpose: "family" },
    ];
    for (const [i, v] of visits.entries()) {
      const id = await signInVisitor(app, admin, {
        fullName: v.fullName,
        phone: phone(),
        organisation: v.organisation,
        purpose: v.purpose,
        hostMembershipId: v.host,
        campusId: input.campusId,
        badge: `V${10 + i}`,
      });
      if (i >= 2) await signOutVisitor(app, admin, id);
    }
  }
  const youngest = classIds.get(levels[0]!)!;
  const pickupClasses = [...new Set([youngest, classIds.get(levels[1] ?? levels[0]!)!, input.featuredClass])];
  for (const classId of pickupClasses)
    for (const s of studentsIn(classId))
      await setGuardianFlags(app, proprietor, s.id, s.guardianId, {
        isFeePayer: true,
        isEmergencyContact: true,
        canPickUp: true,
        receivesMessages: true,
      });
  const kg = studentsIn(youngest);
  for (const s of kg.slice(0, 4))
    await addCollector(app, proprietor, s.id, {
      fullName: `${rng.pick(GIRLS)} ${s.lastName}`,
      relationship: rng.pick(["Aunt", "Grandmother", "Older sister"]),
      phone: phone(),
    });
  if (input.isSchoolDay(today)) {
    const classTeacher = await input.ctxOf(people.teachers[0]!.userId);
    for (const s of kg.slice(0, Math.floor(kg.length * 0.6)))
      await releaseStudent(app, classTeacher, s.id, { collector: `guardian:${s.guardianId}` });
    await refusePickup(app, classTeacher, kg[kg.length - 1]!.id, {
      personName: "Unknown man",
      relationship: "Said he was a neighbour",
      reason: "Not on the child's list; the mother was called and collected her.",
    });
  }
  log("Visitors and pickups.");

  // ---- Transport: two buses and routes, riders, fares through the term's billing, today's trip.
  const transportItem = await createFeeItem(app, proprietor, { name: "Transport" });
  await setFeeItemDetails(app, proprietor, transportItem, { category: "transport", optional: true });
  await setTransportFeeItem(app, bursar, transportItem);
  const routes = [
    {
      vehicle: { name: "Bus 1", registration: "GT 4512-21", seats: "33", driverName: "Kwesi Appiah" },
      name: "Tema Community 25",
      fare: "450",
      stops: [
        ["Community 25 junction", "06:35", "15:55"],
        ["Kpone barrier", "06:50", "15:40"],
        ["Michel Camp", "07:05", "15:25"],
      ],
    },
    {
      vehicle: { name: "Bus 2", registration: "GE 8820-22", seats: "26", driverName: "Yaw Ntim" },
      name: "Spintex Road",
      fare: "520",
      stops: [
        ["Coca-Cola roundabout", "06:30", "16:00"],
        ["Baatsona total", "06:45", "15:45"],
        ["Flower Pot junction", "07:00", "15:30"],
      ],
    },
  ];
  const riders = roster.filter(() => rng.chance(0.14));
  const routeIds: string[] = [];
  let r = 0;
  for (const route of routes) {
    const vehicleId = await saveVehicle(app, proprietor, { ...route.vehicle, driverPhone: phone() });
    const routeId = await saveRoute(app, proprietor, { name: route.name, vehicleId });
    routeIds.push(routeId);
    const stopIds: string[] = [];
    for (const [name, morningTime, afternoonTime] of route.stops)
      stopIds.push(await saveStop(app, proprietor, routeId, { name, morningTime, afternoonTime }));
    await setFares(app, bursar, routeId, {
      fare: route.fare,
      [`stop:${stopIds[2]}`]: String(Number(route.fare) - 100),
    });
    const mine = riders.filter((_, i) => i % 2 === r);
    for (const s of mine)
      await assignStudent(app, head, {
        studentId: s.id,
        stopId: rng.pick(stopIds),
        direction: rng.chance(0.8) ? "both" : rng.chance(0.5) ? "to_school" : "from_school",
      });
    r++;
  }
  if (input.isSchoolDay(today)) {
    const trip = await getTrip(app, teacher, routeIds[0]!, "to_school");
    for (const rider of trip.riders) {
      await markBoarded(app, teacher, routeIds[0]!, "to_school", rider.studentId);
      await markLeft(app, teacher, routeIds[0]!, "to_school", rider.studentId);
    }
  }
  log(`Transport: ${routes.length} routes, ${riders.length} riders.`);

  // ---- Inventory: suppliers, stock with movements, assets, repairs and purchase requests.
  const suppliers = {
    stationery: await saveSupplier(app, bursar, { name: "Accra Stationers", phone: phone() }),
    cleaning: await saveSupplier(app, bursar, { name: "Kantamanto Cleaning Supplies", phone: phone() }),
    food: await saveSupplier(app, bursar, { name: "Makola Foodstuffs", phone: phone() }),
  };
  const stock: [string, string, string, string, number, number, string][] = [
    ["A4 paper", "Stationery", "ream", "10", 40, 45, suppliers.stationery],
    ["Exercise books", "Stationery", "pack", "20", 120, 18, suppliers.stationery],
    ["Chalk", "Stationery", "box", "8", 30, 12, suppliers.stationery],
    ["Whiteboard markers", "Stationery", "pack", "6", 10, 35, suppliers.stationery],
    ["Toilet paper", "Cleaning", "pack", "15", 50, 28, suppliers.cleaning],
    ["Liquid soap", "Cleaning", "gallon", "6", 12, 60, suppliers.cleaning],
    ["Rice", "Kitchen", "bag", "4", 12, 520, suppliers.food],
    ["Cooking oil", "Kitchen", "gallon", "5", 8, 180, suppliers.food],
  ];
  const stockIds = new Map<string, string>();
  for (const [name, category, unit, reorderLevel, received, cost, supplierId] of stock) {
    const id = await saveStockItem(app, bursar, { name, category, unit, reorderLevel });
    stockIds.set(name, id);
    await recordMovement(app, bursar, id, {
      kind: "received",
      quantity: String(received),
      unitCost: String(cost),
      supplierId,
    });
    // Issued through the term; a few items run low.
    let left = received;
    for (let i = 0; i < 3; i++) {
      const quantity = Math.max(1, Math.floor(left * (rng.int(15, 35) / 100)));
      if (quantity >= left) break;
      left -= quantity;
      await recordMovement(app, bursar, id, {
        kind: "issued",
        quantity: String(quantity),
        issuedTo: category === "Kitchen" ? "Kitchen" : rng.pick(levels),
      });
    }
  }
  const assets: [string, string, string, string, string][] = [
    ["Epson projector", "ICT", "ICT lab", "good", "3500"],
    ["Dell laptop", "ICT", "Office", "good", "6200"],
    ["Dell laptop", "ICT", "ICT lab", "fair", "6200"],
    ["Photocopier", "Office", "Office", "fair", "14800"],
    ["Standing fan", "Furniture", levels[0]!, "good", "450"],
    ["Generator 7.5 kVA", "Plant", "Generator house", "good", "18500"],
    ["Water dispenser", "Kitchen", "Staff room", "new", "1300"],
    ["Keyboard (music)", "Music", "Hall", "poor", "2100"],
  ];
  let projector: string | null = null;
  for (const [name, category, location, condition, cost] of assets) {
    const a = await addAsset(app, proprietor, { name, category, location, condition, cost });
    projector ??= a.id;
  }
  await changeAsset(app, proprietor, projector!, {
    location: "Staff room",
    custodianMembershipId: people.head.membershipId,
    condition: "good",
    note: "Kept in the staff room between lessons.",
  });
  const fan = await reportMaintenance(app, teacher, {
    title: "Ceiling fan not working",
    location: levels[5] ?? "Classroom",
    priority: "urgent",
  });
  await reportMaintenance(app, bursar, { title: "Leaking tap in the staff room", priority: "low" });
  const roof = await reportMaintenance(app, head, {
    title: "Roof leak over the library",
    location: "Library",
    priority: "normal",
  });
  await updateMaintenance(app, head, fan.id, { status: "in_progress", assignedTo: "Kofi the electrician" });
  await updateMaintenance(app, head, roof.id, { status: "in_progress", assignedTo: "Asante Roofing" });
  await updateMaintenance(app, head, roof.id, {
    status: "done",
    assignedTo: "Asante Roofing",
    note: "Two sheets replaced and the gutter cleared.",
  });
  const exams = await createPurchaseRequest(app, bursar, {
    title: "Paper for end-of-term exams",
    description_0: "A4 paper",
    quantity_0: "20",
    price_0: "45",
    stockItemId_0: stockIds.get("A4 paper"),
    description_1: "Staples",
    quantity_1: "5",
    price_1: "12",
  });
  await decidePurchaseRequest(app, proprietor, exams.id, { approve: true });
  const detail = (await getPurchaseRequest(app, bursar, exams.id))!;
  await receivePurchaseRequest(app, bursar, exams.id, {
    [`received_${detail.lines[0]!.id}`]: "20",
    [`received_${detail.lines[1]!.id}`]: "5",
  });
  await createPurchaseRequest(app, head, {
    title: "Science lab equipment",
    description_0: "Microscopes",
    quantity_0: "4",
    price_0: "850",
    description_1: "Beakers (set of 10)",
    quantity_1: "3",
    price_1: "120",
  });
  log("Inventory: stock, assets, repairs and purchases.");

  // ---- Library: a catalogue, loans to students and staff, some overdue and returned.
  await saveLoanRules(app, proprietor, { loanDays: "14", maxLoans: "2" });
  await saveFineRules(app, bursar, { finesEnabled: "on", finePerDay: "0.50", fineCap: "5.00" });
  const books: [string, string, string, number][] = [
    ["Things Fall Apart", "Chinua Achebe", "Fiction", 4],
    ["Anowa", "Ama Ata Aidoo", "Drama", 3],
    ["The Beautyful Ones Are Not Yet Born", "Ayi Kwei Armah", "Fiction", 2],
    ["Weep Not, Child", "Ngũgĩ wa Thiong'o", "Fiction", 3],
    ["The Gods Are Not to Blame", "Ola Rotimi", "Drama", 3],
    ["Ananse Stories", "Traditional, retold", "Children", 5],
    ["Akosua and the Talking Drum", "Classroom reader", "Children", 4],
    ["Mathematics for JHS 1", "Ghana Education Service", "Textbook", 6],
    ["Integrated Science for JHS", "Ghana Education Service", "Textbook", 6],
    ["Our World Our People", "Ghana Education Service", "Textbook", 5],
    ["A Children's Atlas of Ghana", "Classroom reference", "Reference", 2],
    ["The Lion and the Jewel", "Wole Soyinka", "Drama", 2],
  ];
  const copyNumbers: string[] = [];
  for (const [title, author, category, copies] of books) {
    const id = await saveTitle(app, proprietor, {
      title,
      author,
      category,
      copies: String(copies),
      shelf: category,
    });
    copyNumbers.push(...(await getTitle(app, proprietor, id))!.copyList.map((c) => c.number));
  }
  await addCopies(
    app,
    head,
    await saveTitle(app, proprietor, { title: "Akwaaba Ghana", category: "Reference", copies: "1" }),
    { count: "1" },
  );
  const borrowers = await listBorrowerOptions(app, proprietor);
  const staffBorrower = borrowers.find((b) => b.key.startsWith("member:") || !b.key.startsWith("student:"));
  // Older children borrow (from Basic 2 up); a small school lends to everyone.
  const olderChildren = roster.filter(
    (s) => levels.indexOf([...classIds].find(([, id]) => id === s.classId)![0]) >= 3,
  );
  const readers = olderChildren.length > 0 ? olderChildren : roster;
  // One book per child at most (the limit is two), so a small school lends fewer.
  const loanCopies = copyNumbers.filter((_, i) => i % 3 !== 2).slice(0, Math.min(34, readers.length + 1));
  const lent: { copy: string; studentId: string }[] = [];
  for (const [i, copy] of loanCopies.entries()) {
    if (i === 0 && staffBorrower) {
      await lendCopy(app, proprietor, { copy, borrower: staffBorrower.key });
      continue;
    }
    const s = readers[((i - 1) * 7) % readers.length]!;
    await lendCopy(app, proprietor, { copy, borrower: `student:${s.id}` });
    lent.push({ copy, studentId: s.id });
  }
  // Some came back; a few are overdue (written as if they were borrowed weeks ago).
  for (const l of lent.slice(0, 10))
    await returnLoan(app, proprietor, await findOpenLoan(app, proprietor, l.copy));
  for (const [i, l] of lent.slice(10, 16).entries()) {
    const loanId = await findOpenLoan(app, proprietor, l.copy);
    await input.asTenant((tx) =>
      tx
        .update(libraryLoans)
        .set({ dueOn: sql`current_date - ${2 + i * 2}::int` })
        .where(eq(libraryLoans.id, loanId)),
    );
  }
  log(`Library: ${books.length + 1} titles, ${loanCopies.length} loans.`);

  // ---- Boarding: two houses for JHS boarders, the boarding fee, a housemaster, exeats.
  const boardingItem = await createFeeItem(app, proprietor, { name: "Boarding" });
  await setFeeItemDetails(app, proprietor, boardingItem, { category: "boarding", optional: true });
  const jhs = levels.filter((l) => l.startsWith("JHS"));
  for (const level of jhs) await input.saveLevelFeesWith(level, { [boardingItem]: "2600" });
  await setBoardingFeeItem(app, bursar, boardingItem);
  const boysHouse = await saveHouse(app, proprietor, { name: "Aggrey House", kind: "boys" });
  const girlsHouse = await saveHouse(app, proprietor, { name: "Yaa Asantewaa House", kind: "girls" });
  for (const house of [boysHouse, girlsHouse])
    for (const room of ["Dormitory A", "Dormitory B"])
      await addRoom(app, proprietor, house, { name: room, beds: "8" });
  const bedsOf = async (house: string) =>
    (await getHouse(app, proprietor, house))!.rooms.flatMap((room) => room.beds);
  const jhsStudents = roster.filter((s) => jhs.some((l) => classIds.get(l) === s.classId));
  const boarders = jhsStudents.filter(() => rng.chance(0.3));
  const beds = { male: await bedsOf(boysHouse), female: await bedsOf(girlsHouse) };
  const used = { male: 0, female: 0 };
  const placed: DemoStudent[] = [];
  for (const s of boarders) {
    const bed = beds[s.sex][used[s.sex]];
    if (!bed) continue;
    used[s.sex]++;
    await placeBoarder(app, proprietor, { studentId: s.id, bedId: bed.id });
    placed.push(s);
  }
  const lastTeacher = people.teachers[people.teachers.length - 1]!;
  const housemaster = people.teachers.find((t) => t.level.startsWith("JHS")) ?? lastTeacher;
  const housemistress = people.teachers.filter((t) => t.level.startsWith("JHS"))[1] ?? people.teachers[0]!;
  const staffOptions = await listStaffOptions(app, proprietor);
  const optionId = (membershipId: string) =>
    staffOptions.find((o) => o.id === membershipId)?.id ?? membershipId;
  await appointHouseStaff(app, proprietor, boysHouse, optionId(housemaster.membershipId));
  await appointHouseStaff(app, proprietor, girlsHouse, optionId(housemistress.membershipId));
  const out = placed.slice(0, 3);
  for (const [i, s] of out.entries())
    await signOutBoarder(app, head, {
      studentId: s.id,
      reason: i === 0 ? "Hospital appointment" : "Family visit for the weekend",
      collectedBy: `${s.guardianName}, guardian`,
      expectedBackOn: addDays(today, i + 1),
    });
  const exeats = await listExeats(app, head);
  if (exeats.out[0]) await signInBoarder(app, head, exeats.out[0].id);
  log(`Boarding: ${placed.length} boarders in 2 houses.`);

  // Transport fares and boarding fees go through the term's billing, as when the accountant bills again.
  await billTerm(app, bursar, term.id);

  // ---- Timetable: the school day and every class's week, taught by the class teacher.
  const periods: { id: string }[] = [];
  const day: [string, string, string, "lesson" | "break"][] = [
    ["Period 1", "08:00", "08:45", "lesson"],
    ["Period 2", "08:45", "09:30", "lesson"],
    ["Break", "09:30", "09:50", "break"],
    ["Period 3", "09:50", "10:35", "lesson"],
    ["Period 4", "10:35", "11:20", "lesson"],
    ["Lunch", "11:20", "12:00", "break"],
    ["Period 5", "12:00", "12:45", "lesson"],
    ["Period 6", "12:45", "13:30", "lesson"],
  ];
  for (const [name, startsAt, endsAt, kind] of day) {
    const p = await savePeriod(app, proprietor, { name, startsAt, endsAt, kind });
    if (kind === "lesson") periods.push(p);
  }
  for (const t of people.teachers) {
    const classId = classIds.get(t.level)!;
    const subjects = await input.asTenant(async (tx) =>
      (
        await tx
          .select({ id: levelSubjects.subjectId })
          .from(levelSubjects)
          .where(
            and(
              eq(levelSubjects.tenantId, input.tenantId),
              eq(levelSubjects.levelId, input.levelIdOf(t.level)),
            ),
          )
      ).map((x) => x.id),
    );
    if (subjects.length === 0) continue;
    let k = 0;
    for (let weekday = 1; weekday <= 5; weekday++)
      for (const period of periods)
        await setLesson(app, proprietor, {
          termId: term.id,
          classId,
          weekday,
          periodId: period.id,
          subjectId: subjects[k++ % subjects.length],
          membershipId: t.membershipId,
        });
  }
  log("Timetable for every class.");

  // ---- Announcements, events and a consent form.
  await postAnnouncement(app, head, {
    title: "Mid-term break",
    body: "School closes on Thursday at 12:00 and reopens on Tuesday. Have a restful break.",
    audience: "school",
    audienceId: null,
    sms: false,
  });
  await postAnnouncement(app, head, {
    title: "PTA meeting this month",
    body: "All parents are invited to the PTA meeting in the school hall. The agenda includes the new library and the school bus routes.",
    audience: "school",
    audienceId: null,
    sms: false,
  });
  await postAnnouncement(app, teacher, {
    title: "Reading week",
    body: "Each child should bring a storybook from home every day next week.",
    audience: "class",
    audienceId: input.featuredClass,
    sms: false,
  }).catch(async () =>
    postAnnouncement(app, head, {
      title: "Reading week",
      body: "Each child should bring a storybook from home every day next week.",
      audience: "class",
      audienceId: input.featuredClass,
      sms: false,
    }),
  );
  const trip = await createEvent(app, head, {
    title: "Trip to Cape Coast Castle",
    startsOn: addDays(today, 12),
    startTime: "6:30",
    endTime: "17:00",
    location: "Cape Coast",
    audience: "class",
    audienceId: input.featuredClass,
  });
  await createEvent(app, head, {
    title: "Inter-house sports day",
    startsOn: addDays(today, 18),
    startTime: "8:00",
    endTime: "15:00",
    location: "School field",
    audience: "school",
    audienceId: null,
  });
  await createEvent(app, head, {
    title: "PTA meeting",
    startsOn: addDays(today, 9),
    startTime: "10:00",
    location: "School hall",
    audience: "school",
    audienceId: null,
  });
  const form = await createConsentForm(app, head, {
    title: "Cape Coast Castle trip",
    body: "Your child will travel by school bus with their teachers. Cost: GH₵60 for transport and entry. Please say yes or no.",
    deadline: addDays(today, 8),
    eventId: trip.id,
    audience: "class",
    audienceId: input.featuredClass,
    sms: false,
  });
  for (const s of featured.slice(0, 12))
    await recordPaperAnswer(app, head, form.id, {
      studentId: s.id,
      guardianId: s.guardianId,
      answer: rng.chance(0.85) ? "yes" : "no",
      note: "Signed slip",
    });
  log("Announcements, events and a consent form.");

  // ---- Admissions: families asking about places, at every step.
  const statuses = [
    "inquiry",
    "inquiry",
    "applied",
    "applied",
    "applied",
    "applied",
    "applied",
    "applied",
    "applied",
  ];
  const sources = [
    "walk_in",
    "phone",
    "referral",
    "event",
    "walk_in",
    "referral",
    "phone",
    "walk_in",
    "other",
  ];
  const applications: string[] = [];
  for (const [i, status] of statuses.entries()) {
    const female = rng.chance(0.5);
    const surname = rng.pick(SURNAMES);
    const level = levels[Math.min(levels.length - 1, rng.int(0, 6))]!;
    const { id } = await createApplication(app, head, {
      status,
      source: sources[i],
      childFirstName: rng.pick(female ? GIRLS : BOYS),
      childLastName: surname,
      sex: female ? "female" : "male",
      dateOfBirth: `${Number(today.slice(0, 4)) - 4 - levels.indexOf(level)}-0${rng.int(1, 9)}-1${rng.int(0, 8)}`,
      levelId: input.levelIdOf(level),
      guardianName: `${rng.pick(GIRLS)} ${surname}`,
      guardianPhone: phone(),
      guardianRelationship: "mother",
    });
    applications.push(id);
  }
  for (const id of applications.slice(2, 6))
    await recordAssessment(app, head, id, {
      at: `${addDays(today, 3)}T09:30`,
      note: "Reading and number test",
    });
  for (const id of applications.slice(4, 6))
    await makeOffer(app, head, id, { entryTermId: term.id, respondBy: addDays(today, 14) });
  await moveApplication(app, head, applications[6]!, {
    to: "declined",
    note: "No place left in that class this year.",
  });
  await moveApplication(app, head, applications[7]!, {
    to: "withdrawn",
    note: "The family moved to Kumasi.",
  });
  log(`Admissions: ${applications.length} applications.`);

  // ---- Early warning: the featured class teacher reviews this week's indicators.
  const ew = await getEarlyWarning(app, teacher);
  const waiting = ew.indicators.filter((i) => !i.review);
  const [first, second, third] = waiting;
  if (first)
    await reviewIndicator(app, teacher, {
      key: first.key,
      outcome: "no_action",
      reason: "Was in hospital for a week; the mother called the school each day.",
    });
  if (second)
    await reviewIndicator(app, teacher, {
      key: second.key,
      outcome: "support_plan",
      reason: "Missing days without a call from home.",
      goal: "Attends every day for the rest of the term",
      actions: "Call home after any absence; weekly check-in with the class teacher.",
      responsible: "Class teacher",
      reviewOn: addDays(today, 14),
    });
  if (third) {
    await reviewIndicator(app, teacher, {
      key: third.key,
      outcome: "referred",
      reason: "Marks have fallen in most subjects; the Head teacher should meet the family.",
    });
    await openSupportPlan(app, head, {
      studentId: third.student.id,
      goal: "Marks recover to last term's level",
      actions: "Meet the family; extra reading and maths support twice a week.",
      responsible: "Head teacher",
      reviewOn: addDays(today, 21),
    });
  }
  log(
    `Early warning: ${ew.indicators.length} indicators in the featured class, ${Math.min(3, waiting.length)} reviewed.`,
  );

  // ---- Finance checks: a repeated bank slip, voids by one person, a refund waiting for approval.
  const payers = roster.slice(0, 2);
  const slip = `SLIP-${rng.digits(6)}`;
  for (const [i, s] of payers.entries())
    await recordPayment(app, bursar, {
      studentId: s.id,
      amount: "100",
      method: "bank_deposit",
      reference: slip,
      payerName: s.guardianName,
      paidOn: addDays(today, -1 - i),
      idempotencyKey: randomUUID(),
      confirmDuplicate: i > 0,
    });
  const recent = await input.asTenant((tx) =>
    tx
      .select({ id: payments.id })
      .from(payments)
      .where(and(eq(payments.tenantId, input.tenantId), eq(payments.method, "cash")))
      .orderBy(sql`${payments.recordedAt} desc`)
      .limit(3),
  );
  for (const p of recent)
    await voidPayment(app, proprietor, p.id, { reason: "Entered against the wrong student" });
  const inCredit = await input.asTenant(
    async (tx) =>
      (
        await tx.execute<{ student_id: string; balance: string }>(
          sql`select student_id, sum(amount_pesewas) as balance from ledger_entries where tenant_id = ${input.tenantId} group by student_id having sum(amount_pesewas) <= -5000 order by 2 limit 1`,
        )
      ).rows,
  );
  if (inCredit[0])
    await requestRefund(app, bursar, inCredit[0].student_id, {
      amount: pesewasToInput(Math.min(-Number(inCredit[0].balance), 15000)),
      reason: "Family moving abroad; credit refunded on request",
    });
  log("Finance checks: a repeated slip, three voids and a refund request.");
  return { paymentsAdded: payers.length, paymentsVoided: recent.length };
}
