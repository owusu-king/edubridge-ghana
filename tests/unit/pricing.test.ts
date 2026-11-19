import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRICING_RULES,
  SIZE_BANDS,
  SUGGESTED_ADD_ONS,
  SUGGESTED_PLANS,
  bandFor,
  bandLabel,
  bandsFromCedis,
  discountOf,
  percentLabel,
  periodPrice,
  termlyEquivalent,
  validBands,
} from "@/lib/pricing";
import { MODULES, PLAN_MODULE_IDS } from "@/lib/modules";

const bands = bandsFromCedis([1200, 2100, 3600, 5500]);

describe("size bands", () => {
  it("prices a school by the smallest band that covers it, and none above the last", () => {
    expect(bandFor(0, bands)?.upTo).toBe(150);
    expect(bandFor(150, bands)?.upTo).toBe(150);
    expect(bandFor(151, bands)?.upTo).toBe(300);
    expect(bandFor(1000, bands)?.termlyMinor).toBe(550_000);
    expect(bandFor(1001, bands)).toBeNull();
    expect(bandLabel(bands[0]!, bands)).toBe("up to 150 students");
    expect(bandLabel(bands[2]!, bands)).toBe("301 to 600 students");
  });

  it("accepts only a full set of bands that never fall as schools grow", () => {
    expect(validBands(bands)).toBe(true);
    expect(validBands(bands.slice(0, 3))).toBe(false);
    expect(validBands(bandsFromCedis([1200, 1100, 3600, 5500]))).toBe(false);
    expect(validBands(bandsFromCedis([0, 2100, 3600, 5500]))).toBe(false);
  });
});

describe("billing periods", () => {
  const terms = { inYear: 3, covered: 3 };

  it("charges a term as it is, a year less the discount, and a month a little more than its share", () => {
    expect(periodPrice(180_000, "termly", DEFAULT_PRICING_RULES, terms)).toBe(180_000);
    // Three terms (540,000) less 12%: 475,200.
    expect(periodPrice(180_000, "annual", DEFAULT_PRICING_RULES, terms)).toBe(475_200);
    // A twelfth of three terms (45,000) plus 10%: 49,500.
    expect(periodPrice(180_000, "monthly", DEFAULT_PRICING_RULES, terms)).toBe(49_500);
    // Paying for the rest of the year from Term 2: two terms.
    expect(periodPrice(180_000, "annual", DEFAULT_PRICING_RULES, { inYear: 3, covered: 2 })).toBe(316_800);
  });

  it("rounds yearly and monthly prices to whole cedis", () => {
    expect(periodPrice(123_456, "annual", DEFAULT_PRICING_RULES, terms) % 100).toBe(0);
    expect(periodPrice(123_456, "monthly", DEFAULT_PRICING_RULES, terms) % 100).toBe(0);
  });

  it("converts an add-on's price to a termly equivalent", () => {
    expect(termlyEquivalent(45_000, "termly", 3)).toBe(45_000);
    expect(termlyEquivalent(135_000, "annual", 3)).toBe(45_000);
    expect(termlyEquivalent(15_000, "monthly", 3)).toBe(60_000);
  });

  it("works out discounts and labels", () => {
    expect(discountOf(250_000, 2000)).toBe(50_000);
    expect(percentLabel(1200)).toBe("12%");
    expect(percentLabel(1250)).toBe("12.5%");
  });
});

describe("the suggested plans", () => {
  it("are priced for every band, cost more as they include more, and name real modules", () => {
    expect(SUGGESTED_PLANS.map((p) => p.name)).toEqual(["Starter", "Standard", "Premium"]);
    for (const plan of SUGGESTED_PLANS) {
      expect(validBands(bandsFromCedis(plan.termlyCedis))).toBe(true);
      for (const f of plan.features) expect(PLAN_MODULE_IDS).toContain(f);
    }
    const [starter, standard, premium] = SUGGESTED_PLANS;
    expect(starter!.features.every((f) => standard!.features.includes(f))).toBe(true);
    expect(standard!.features.every((f) => premium!.features.includes(f))).toBe(true);
    SIZE_BANDS.forEach((_, i) => {
      expect(starter!.termlyCedis[i]).toBeLessThan(standard!.termlyCedis[i]!);
      expect(standard!.termlyCedis[i]).toBeLessThan(premium!.termlyCedis[i]!);
    });
  });

  it("leave the operations modules as add-ons, priced per term, and never sell safeguarding alone", () => {
    for (const a of SUGGESTED_ADD_ONS) expect(MODULES[a.module].purchasable).toBe(true);
    expect(SUGGESTED_ADD_ONS.map((a) => a.module)).not.toContain("safeguarding");
    const inPremium = new Set(SUGGESTED_PLANS[2]!.features);
    for (const m of ["transport", "boarding", "library", "inventory_assets"] as const)
      expect(inPremium.has(m)).toBe(false);
  });
});
