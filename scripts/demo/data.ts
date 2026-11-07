/**
 * Made-up people for demo schools. Common Ghanaian names, combined at random: any resemblance to a real
 * person is coincidence. Phone numbers are random and never receive messages (demo schools send none).
 */

export const GIRLS = [
  "Akua",
  "Ama",
  "Abena",
  "Adwoa",
  "Afia",
  "Akosua",
  "Yaa",
  "Efua",
  "Esi",
  "Ekua",
  "Araba",
  "Adjoa",
  "Nana",
  "Naa",
  "Dzifa",
  "Senam",
  "Elikem",
  "Mawusi",
  "Lamisi",
  "Fatima",
  "Aisha",
  "Hawa",
  "Gifty",
  "Grace",
  "Priscilla",
  "Patience",
  "Joyce",
  "Mavis",
  "Comfort",
  "Abigail",
  "Ruth",
  "Deborah",
  "Esther",
  "Nhyira",
  "Ohemaa",
  "Maame",
  "Sedinam",
  "Yayra",
  "Fafa",
  "Selasi",
];

export const BOYS = [
  "Kwame",
  "Kofi",
  "Kwabena",
  "Kwaku",
  "Yaw",
  "Kwesi",
  "Kojo",
  "Kobina",
  "Fiifi",
  "Ekow",
  "Nii",
  "Nana",
  "Selorm",
  "Edem",
  "Mawuli",
  "Elorm",
  "Senyo",
  "Abdul",
  "Ibrahim",
  "Mohammed",
  "Issah",
  "Emmanuel",
  "Daniel",
  "Samuel",
  "Michael",
  "Ebenezer",
  "Isaac",
  "Prince",
  "Richard",
  "Joseph",
  "Bernard",
  "Kelvin",
  "Jeffrey",
  "Nathaniel",
  "Godwin",
  "Eric",
  "Benjamin",
  "Caleb",
  "Jesse",
  "Felix",
];

export const SURNAMES = [
  "Mensah",
  "Owusu",
  "Boateng",
  "Asante",
  "Osei",
  "Agyei",
  "Addo",
  "Quaye",
  "Tetteh",
  "Lartey",
  "Amoah",
  "Ofori",
  "Darko",
  "Appiah",
  "Acheampong",
  "Bonsu",
  "Donkor",
  "Frimpong",
  "Gyamfi",
  "Kumi",
  "Mintah",
  "Nyarko",
  "Sarpong",
  "Yeboah",
  "Agbeko",
  "Dzamesi",
  "Kpodo",
  "Tsikata",
  "Abubakar",
  "Alhassan",
  "Adjei",
  "Ansah",
  "Baah",
  "Danso",
  "Opoku",
  "Wiredu",
  "Antwi",
  "Badu",
  "Fosu",
  "Nkansah",
  "Aidoo",
  "Arthur",
  "Quansah",
  "Essien",
  "Annan",
  "Hammond",
  "Botchway",
  "Allotey",
  "Okine",
  "Amponsah",
];

/** Staff names (adults), by role. */
export const STAFF = {
  owner: "Theodora Adomako",
  head: "Francis Ankrah",
  admin: "Linda Ocansey",
  bursar: "Gloria Asamoah",
  teachers: [
    "Rita Agyeman",
    "Solomon Tagoe",
    "Juliana Mensah",
    "Peter Kyei",
    "Regina Osafo",
    "Albert Nortey",
    "Cecilia Dankwa",
    "Stephen Amankwah",
    "Vida Boakye",
    "Hayford Owusu",
    "Beatrice Ayim",
    "Martin Afriyie",
    "Sandra Kwarteng",
    "Cyril Dogbe",
  ],
};

export const ABSENCE_REASONS = ["Sick", "Sick", "Travelled", "Family event", "Hospital visit"];
export const ATTITUDES = ["Hardworking", "Attentive", "Cheerful", "Calm and focused", "Eager to learn"];
export const CONDUCT = ["Very good", "Good", "Good", "Satisfactory"];
export const INTERESTS = ["Reading", "Football", "Music", "Drawing", "Science club", "Drama", "Athletics"];

export function classTeacherRemark(average: number): string {
  if (average >= 80) return "An excellent term. Keep up the hard work.";
  if (average >= 70) return "A very good term. Aim even higher next term.";
  if (average >= 60) return "A good term. More effort in weaker subjects will help.";
  if (average >= 50) return "A fair term. Needs to read more at home.";
  return "Has the ability to do better. Needs closer support at home and in class.";
}

export function headTeacherRemark(average: number): string {
  if (average >= 75) return "Well done.";
  if (average >= 55) return "Good progress. Keep it up.";
  return "We will work with you to improve next term.";
}

/** A small seeded random generator (mulberry32), so the same seed gives the same school. */
export function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  /** Roughly normal (sum of uniforms). */
  const normal = (mean: number, spread: number) => mean + (next() + next() + next() - 1.5) * spread * 1.15;
  const digits = (n: number) => Array.from({ length: n }, () => int(0, 9)).join("");
  return { next, int, pick, normal, digits, chance: (p: number) => next() < p };
}
export type Random = ReturnType<typeof random>;
