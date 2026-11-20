import {
  BarChart3,
  BookOpenCheck,
  Building2,
  HeartHandshake,
  Landmark,
  Radar,
  type LucideIcon,
} from "lucide-react";

/*
 * The landing page's words (2026-11-19, second direction). EduBridge is positioned as the complete operating system
 * for schools: every major function of running a school on one connected set of records, with the intelligence on
 * top that tells an owner how the school is doing. Ghana is where it starts, not its boundary.
 *
 * Every statement here was checked against the product's code on 2026-11-19. Deliberately left out until they are
 * true: a student portal, behaviour indicators, languages other than English, Mobile Money outside Ghana, backups and
 * uptime guarantees, certifications, customer numbers and testimonials. Plan contents come from src/lib/pricing.ts;
 * prices are not shown because they are not final.
 */

export const HERO = {
  audience: "For school owners in Ghana and Beyond.",
  title: "The complete operating system for schools.",
  tagline: "Built for Africa. Ready for the world.",
  lead: "Fees and finances, academics, staff, parents and daily operations in one connected platform, giving you one reliable picture of your school and early warning of what needs your attention.",
  pilot: "Your first term is free.",
};

/** The problems an owner lives with, each answered by what the product does. */
export const PROBLEMS: { problem: string; answer: string }[] = [
  {
    problem: "Is the school financially healthy?",
    answer:
      "Collections, balances owed and spending for the term on one screen, with a forecast of what is still likely to come in.",
  },
  {
    problem: "Which students are slipping?",
    answer:
      "Attendance and marks are checked against rules you set, and the students who need attention are listed with the evidence.",
  },
  {
    problem: "Where is that record?",
    answer:
      "Registers, marks, fees, staff files and messages live in one place instead of exercise books, spreadsheets and phones.",
  },
  {
    problem: "Is anyone taking money?",
    answer:
      "Receipts cannot be altered, Mobile Money is confirmed with the network, and unusual activity is pointed out to you.",
  },
  {
    problem: "Can I see without standing over everyone?",
    answer:
      "Every person works within their role, every sensitive action is recorded, and the picture updates as they work.",
  },
];

export const PILLARS: { icon: LucideIcon; title: string; body: string; href: string }[] = [
  {
    icon: Radar,
    title: "Student intelligence",
    body: "Early warning on attendance and marks, with support plans.",
    href: "#intelligence",
  },
  {
    icon: BarChart3,
    title: "Management insight",
    body: "Trends, forecasts and board summaries from your own records.",
    href: "#insight",
  },
  {
    icon: Landmark,
    title: "Finance and accountability",
    body: "Fees, Mobile Money, expenses and the bank, with controls.",
    href: "#finance",
  },
  {
    icon: BookOpenCheck,
    title: "Academics",
    body: "Admissions to report cards, and a passport that travels.",
    href: "#academics",
  },
  {
    icon: Building2,
    title: "Operations",
    body: "Staff, payroll, transport, boarding, library and more.",
    href: "#operations",
  },
  {
    icon: HeartHandshake,
    title: "Families",
    body: "A parent view, SMS and WhatsApp, payments from a phone.",
    href: "#operations",
  },
];

export const INTELLIGENCE = {
  eyebrow: "Student intelligence",
  title: "Know which students need attention while there is still time to help.",
  lead: "Most systems record what happened. EduBridge reads the records your teachers already keep and tells you who may be falling behind, and why.",
  points: [
    "Rules your school sets: attendance below a level, absences in a row, a falling report-card average, subjects below the pass mark.",
    "Each student listed with the evidence behind it, never a score or a ranking. A teacher reviews it and decides what it means.",
    "Support plans with actions and review dates, so a concern becomes a follow-up rather than a note.",
    "Seen only by the staff who should see it. EduBridge support never sees these indicators.",
  ],
};

export const INSIGHT = {
  eyebrow: "Management insight",
  title: "Decide from information, not from guesswork.",
  lead: "The Command Center and Insights turn the day's registers, marks and payments into the picture an owner and a board need, without anyone assembling a report by hand.",
  points: [
    "Fee collection, balances owed by how long, attendance and report-card progress for the term, school-wide or by campus.",
    "Trends across terms and by level, so you see whether results and attendance are improving.",
    "A collections forecast built from your own past terms: what is likely to come in, and the range.",
    "A board summary ready to print, and an assistant that answers questions from your records, within each person's access.",
  ],
};

export const FINANCE = {
  eyebrow: "Finance and accountability",
  title: "See every cedi, from the parent's phone to the bank.",
  lead: "Fees rarely go missing in one large theft; they slip away through small gaps. EduBridge closes those gaps in the system itself.",
  points: [
    {
      title: "Receipts that cannot be altered",
      body: "A recorded payment is never edited or deleted. Mistakes are reversed, and both stay on record with who did it and why.",
    },
    {
      title: "Mobile Money the network confirms",
      body: "A payment counts only once the network confirms it, for the exact amount, and records are compared with the provider every day.",
    },
    {
      title: "Cash followed to the bank",
      body: "Cash and cheques stay listed against whoever took them until they are deposited and matched to the bank statement.",
    },
    {
      title: "Spending with approval",
      body: "Expenses above the amount you set wait for the Proprietor; income against spending is shown month by month.",
    },
    {
      title: "Warnings of unusual activity",
      body: "Many voids by one person, a reference used twice, receipts entered late at night, cash not banked after three days.",
    },
    {
      title: "One prompt for the whole family",
      body: "A parent with several children approves one Mobile Money prompt, and each child gets their own receipt.",
    },
  ],
};

export const ACADEMICS = {
  eyebrow: "Academics",
  title: "The whole academic year, from application to report card.",
  lead: "Admissions, classes, timetables, registers, assessments and report cards share one record of each student, so nothing is typed twice.",
  points: [
    "Online applications with admission fees, then enrolment into classes and streams.",
    "Subjects, timetables and registers that teachers can take on a phone, even with no connection.",
    "Assessments with the weights you choose, positions and remarks, and report cards printed or sent to parents.",
    "The GES way of grading, BECE-style aggregates for JHS, WASSCE grades and electives chosen per student for SHS.",
  ],
  passport: {
    title: "Student Passport",
    body: "When a child moves to another school on EduBridge, their record goes with them, with the family's consent. Each record is signed by EduBridge, and anyone can check that it is genuine and unchanged.",
  },
};

export const OPERATIONS = {
  eyebrow: "Operations",
  title: "Everything else that keeps a school running.",
  lead: "Add what your school needs, when it needs it. Every part works on the same records as the rest.",
  groups: [
    {
      title: "People",
      items: [
        "Staff records and documents",
        "Staff attendance and leave",
        "Payroll and payslips",
        "Roles for every member of staff",
      ],
    },
    {
      title: "Families",
      items: [
        "A parent view, signed in with a phone code",
        "Announcements by SMS and WhatsApp",
        "Events and consent forms",
        "Fee reminders with a link to the balance",
      ],
    },
    {
      title: "Campus",
      items: [
        "Visitors and student pickup",
        "Transport routes and trips",
        "Boarding houses and exeats",
        "Library loans and fines",
      ],
    },
    {
      title: "Administration",
      items: [
        "Stores, assets and repairs",
        "Purchase requests",
        "Safeguarding cases",
        "Several campuses in one school",
      ],
    },
  ],
};

export const TRUST = {
  eyebrow: "Trust",
  title: "Built to be trusted with a school's most sensitive records.",
  lead: "Children's records, families' money and staff files deserve more than a password. Here is what EduBridge does, in plain terms.",
  points: [
    {
      title: "Each school's records are its own",
      body: "Schools are kept apart by the database itself, not only by the application, and an automated check fails any change that would weaken it.",
    },
    {
      title: "Everyone sees what their role needs",
      body: "Proprietor, head, accountant, teacher, cashier and more: each role reaches only its own work, and the server checks it on every request.",
    },
    {
      title: "A record of who did what",
      body: "Payments, voids, fee changes, marks and access are written to a log that cannot be edited.",
    },
    {
      title: "Secure sign-in",
      body: "Two-step verification, required by default for the Proprietor and the Accountant. Parents sign in with a code sent to their phone.",
    },
    {
      title: "Support only with your permission",
      body: "EduBridge staff can open your school only while you allow it, and every page they open is shown to you.",
    },
    {
      title: "Your data stays yours",
      body: "The Proprietor can download the school's records as spreadsheets at any time.",
    },
  ],
};

export const WORLD = {
  eyebrow: "Built for Africa. Ready for the world.",
  title: "One platform, set up for where your school is.",
  lead: "A school's country, currency, calendar and grading are settings, not assumptions in the code. Ghana is where EduBridge begins.",
  countries: [
    "Ghana",
    "Nigeria",
    "Kenya",
    "Uganda",
    "Tanzania",
    "Rwanda",
    "Zambia",
    "South Africa",
    "Côte d'Ivoire",
    "Senegal",
    "Cameroon",
  ],
  facts: [
    {
      title: "Curricula",
      body: "Templates for Ghana (GES), Kenya (CBE), Nigeria (UBE), francophone systems and British-style years.",
    },
    {
      title: "Money",
      body: "Each school bills in its own currency. Mobile Money collection runs in Ghana today.",
    },
    {
      title: "Calendars",
      body: "Terms, holidays and school days set per school, with each country's public holidays suggested.",
    },
    {
      title: "Grading",
      body: "Grading scales and assessment weights the school chooses, including BECE and WASSCE in Ghana.",
    },
  ],
};

export const PRICING = {
  eyebrow: "Pricing",
  title: "Start with a free term.",
  body: "Priced per term by the size of your school. Your first term is free, so your staff can use EduBridge through a full term before you decide.",
};

export const FAQ: { q: string; a: string }[] = [
  {
    q: "Do we need to install anything?",
    a: "No. EduBridge runs in the browser on phones, tablets and computers. It can also be installed like an app, on a phone's home screen or on a computer, where it opens in its own window.",
  },
  {
    q: "Does it work without internet?",
    a: "Teachers can take registers with no connection; they are sent when the network is back. The rest of EduBridge needs a connection.",
  },
  {
    q: "Can we bring our records from the system we use now?",
    a: "Yes. A setup guide takes you through it: your student list with classes and guardians, imported from a spreadsheet, then each family's balance from before.",
  },
  {
    q: "How do parents pay?",
    a: "By Mobile Money from a prompt on their phone, or in cash, by cheque or at the bank, with a numbered receipt for every payment.",
  },
  {
    q: "Who can see our school's information?",
    a: "Only your staff, each within their role, and EduBridge support only while you allow it. Every sensitive action is recorded.",
  },
  {
    q: "Can we use our own grading and fees?",
    a: "Yes. Grading scales, assessment weights, fee items and amounts are set by each school, from suggested templates.",
  },
];

export const VISIT = {
  title: "Book a demo",
  body: "Tell us about your school and we will arrange a time to show you EduBridge with your own questions in mind, at your school or on a call.",
};
