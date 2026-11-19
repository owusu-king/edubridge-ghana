/**
 * Runs the assistant's evaluation set (R5-4, AIP-04) against the seeded synthetic school, and reports each question:
 * passed or not, the figures missing or not checked, tokens and estimated cost. It calls the AI provider, so run it on
 * request, before changing the model, the prompt or a tool; never in CI.
 *
 *   npm run ai:eval -- --provider=ollama --model=llama3.1:8b
 *   npm run ai:eval -- --provider=groq --model=llama-3.3-70b-versatile      (key from AI_API_KEY)
 *   npm run ai:eval -- --provider=anthropic --model=claude-opus-5-5         (paid: only with approval; ANTHROPIC_API_KEY)
 *
 * Options: --school=kpone-ridge (default) --as=owner@example.test (default) --base-url=... --only=owed_today,low_stock
 * Without --provider it uses the platform's own settings. Names are never sent, whatever the provider.
 */
import { eq } from "drizzle-orm";
import { readAiConfig, type AiConfig } from "../src/server/ai/config";
import { EVAL_CASES, runEvaluation } from "../src/server/ai/eval";
import { createDatabase } from "../src/server/db/client";
import { users } from "../src/server/db/schema";
import { resolveTenantContext, type TenantContext } from "../src/server/tenancy/service";
import { AI_PROVIDER_IDS, AI_PROVIDERS, DEFAULT_AI_LIMITS, type AiProviderId } from "../src/lib/ai-providers";
import { isEntrypoint, loadLocalEnv } from "./load-env";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function main() {
  loadLocalEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set.");
  if (process.env.NODE_ENV === "production")
    throw new Error("Run the evaluation against synthetic data only.");
  const { db, pool } = createDatabase(url);
  try {
    const email = arg("as") ?? "owner@example.test";
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (!user) throw new Error(`No user ${email}: seed the database first (npm run db:seed).`);
    const ctx = (await resolveTenantContext(
      db,
      arg("school") ?? "kpone-ridge",
      user.id,
    )) as TenantContext | null;
    if (!ctx) throw new Error(`${email} is not a member of that school.`);

    let config: AiConfig;
    const provider = arg("provider");
    if (provider) {
      if (!(AI_PROVIDER_IDS as readonly string[]).includes(provider) || provider === "none")
        throw new Error(
          `--provider must be one of ${AI_PROVIDER_IDS.filter((p) => p !== "none").join(", ")}.`,
        );
      const id = provider as AiProviderId;
      const info = AI_PROVIDERS[id];
      config = {
        enabled: true,
        provider: id,
        model: arg("model") ?? info.models[0] ?? "",
        baseUrl: arg("base-url") ?? info.baseUrl,
        apiKey: (id === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.AI_API_KEY) || null,
        identifiableApproved: false,
        tasks: { assistant: true, remarks: true, announcements: true, board_report: true },
        // The school's and the platform's allowances still apply (they are read from the database).
        limits: { ...DEFAULT_AI_LIMITS, userPerMinute: 60, userPerHour: 1_000 },
      };
      if (!config.model) throw new Error("Give the model: --model=...");
      if (info.needsKey && !config.apiKey)
        throw new Error("Set the provider's key in the environment first.");
    } else
      config = {
        ...(await readAiConfig(db)),
        enabled: true,
        tasks: { assistant: true, remarks: true, announcements: true, board_report: true },
      };

    const only = arg("only")?.split(",");
    const cases = only ? EVAL_CASES.filter((c) => only.includes(c.id)) : EVAL_CASES;
    console.log(
      `Evaluating ${cases.length} questions with ${config.provider}:${config.model}, as ${email}.\n`,
    );
    const results = await runEvaluation(db, ctx, config, { cases });
    for (const r of results) {
      const mark = r.skipped ? "SKIP" : r.passed ? "PASS" : "FAIL";
      console.log(`${mark}  ${r.id}: ${r.question}`);
      if (r.skipped) console.log(`      ${r.skipped}`);
      else {
        if (r.missing.length) console.log(`      missing: ${r.missing.join(", ")}`);
        if (r.uncheckedFigures.length) console.log(`      not checked: ${r.uncheckedFigures.join(", ")}`);
        if (!r.passed) console.log(`      answer: ${r.answer.replace(/\s+/g, " ").slice(0, 300)}`);
        console.log(`      ${r.inputTokens} in, ${r.outputTokens} out`);
      }
    }
    const ran = results.filter((r) => !r.skipped);
    const passed = ran.filter((r) => r.passed).length;
    const unknownCost = ran.some((r) => r.costMicros === null);
    const cost = ran.reduce((n, r) => n + (r.costMicros ?? 0), 0);
    const tokens = ran.reduce((n, r) => n + r.inputTokens + r.outputTokens, 0);
    console.log(
      `\n${passed} of ${ran.length} passed (${results.length - ran.length} skipped). ${tokens.toLocaleString("en-GH")} tokens; estimated cost ${
        unknownCost ? "unknown for this model" : `US$${(cost / 1_000_000).toFixed(4)}`
      }.`,
    );
    process.exitCode = passed === ran.length ? 0 : 1;
  } finally {
    await pool.end();
  }
}

if (isEntrypoint(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
