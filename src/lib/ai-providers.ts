/**
 * The AI providers EduBridge can use (R5-4, ADR 0004 §3 revision). Free and local providers cost nothing and are
 * de-identified only (AIG-05): their terms are not a data-processing agreement. Only a paid provider can be marked
 * approved for identifiable data, after the data-protection review (D-R5-7).
 */

export const AI_PROVIDER_IDS = ["none", "ollama", "groq", "openai_compatible", "anthropic"] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export interface AiProviderInfo {
  label: string;
  adapter: "openai_compatible" | "anthropic" | null;
  /** What it costs EduBridge: nothing (local or a free tier), or per token. */
  tier: "local" | "free" | "paid" | null;
  /** The address of an OpenAI-compatible API (editable for local and custom providers). */
  baseUrl: string | null;
  baseUrlEditable: boolean;
  needsKey: boolean;
  /** Suggested models (any model the provider offers can be typed). */
  models: readonly string[];
  note: string;
}

export const AI_PROVIDERS: Record<AiProviderId, AiProviderInfo> = {
  none: {
    label: "None (AI off)",
    adapter: null,
    tier: null,
    baseUrl: null,
    baseUrlEditable: false,
    needsKey: false,
    models: [],
    note: "No AI provider. Every page works; AI features say they are not switched on.",
  },
  ollama: {
    label: "Ollama (on our own machine)",
    adapter: "openai_compatible",
    tier: "local",
    baseUrl: "http://localhost:11434/v1",
    baseUrlEditable: true,
    needsKey: false,
    models: ["llama3.1:8b", "qwen2.5:7b", "mistral-nemo"],
    note: "Free, and nothing leaves the machine. For development and controlled testing; needs a model that can use tools.",
  },
  groq: {
    label: "Groq (free tier)",
    adapter: "openai_compatible",
    tier: "free",
    baseUrl: "https://api.groq.com/openai/v1",
    baseUrlEditable: false,
    needsKey: true,
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    note: "Free tier with rate limits; no billing account. De-identified data only. Turn on zero data retention in Groq's data controls.",
  },
  openai_compatible: {
    label: "Other OpenAI-compatible provider",
    adapter: "openai_compatible",
    tier: "paid",
    baseUrl: "",
    baseUrlEditable: true,
    needsKey: true,
    models: [],
    note: "Any provider with an OpenAI-compatible chat API. Treated as paid; check its terms and price first.",
  },
  anthropic: {
    label: "Anthropic Claude (paid)",
    adapter: "anthropic",
    tier: "paid",
    baseUrl: null,
    baseUrlEditable: false,
    needsKey: true,
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    note: "Paid per token. Only after the founder approves the cost and the data-protection review (D-R5-6, D-R5-7).",
  },
};

/** Whether a provider may ever be approved for identifiable data (only paid ones, under an agreement). */
export const canApproveIdentifiable = (id: AiProviderId) => AI_PROVIDERS[id].tier === "paid";

/** US dollars per million tokens, for the estimated cost (free and local providers cost nothing). */
export const MODEL_PRICES: Record<string, { input: number; output: number; cachedInput: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cachedInput: 0.2 },
};

/** Estimated cost of a call in millionths of a US dollar; null when the model's price is not known. */
export function estimateCostMicros(
  provider: AiProviderId,
  model: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
): number | null {
  const tier = AI_PROVIDERS[provider]?.tier;
  if (tier === "local" || tier === "free") return 0;
  const price = MODEL_PRICES[model];
  if (!price) return null;
  const fresh = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return Math.round(
    fresh * price.input + usage.cachedInputTokens * price.cachedInput + usage.outputTokens * price.output,
  );
}

export const AI_TASKS = ["assistant", "remarks", "announcements", "board_report"] as const;
export type AiTask = (typeof AI_TASKS)[number];
export const AI_TASK_LABELS: Record<AiTask, string> = {
  assistant: "School assistant",
  remarks: "Report-card remark suggestions",
  announcements: "Announcement drafts",
  board_report: "Board report drafts",
};

/** Limits (AIG-03), with their defaults: sized for a free tier's rate limits. */
export interface AiLimits {
  platformMonthlyTokens: number;
  schoolMonthlyTokens: number;
  userPerMinute: number;
  userPerHour: number;
  userDailyTokens: number;
  maxOutputTokens: number;
}

export const DEFAULT_AI_LIMITS: AiLimits = {
  platformMonthlyTokens: 5_000_000,
  schoolMonthlyTokens: 500_000,
  userPerMinute: 4,
  userPerHour: 30,
  userDailyTokens: 100_000,
  maxOutputTokens: 1_500,
};

export const AI_LIMIT_RANGES: Record<keyof AiLimits, { min: number; max: number }> = {
  platformMonthlyTokens: { min: 0, max: 1_000_000_000 },
  schoolMonthlyTokens: { min: 0, max: 100_000_000 },
  userPerMinute: { min: 1, max: 60 },
  userPerHour: { min: 1, max: 1_000 },
  userDailyTokens: { min: 1_000, max: 10_000_000 },
  maxOutputTokens: { min: 256, max: 16_000 },
};
