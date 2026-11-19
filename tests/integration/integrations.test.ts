import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { withUser } from "@/server/db/context";
import { platformEvents, platformSecrets, recordSigningKeys } from "@/server/db/schema";
import { exportLearnerRecord, verifyLearnerPackage } from "@/server/passport/records";
import { getAiAdmin, removeAiApiKey, setAiApiKey, updateAiLimits, updateAiSettings } from "@/server/ai/admin";
import { aiKeyName, readAiConfig } from "@/server/ai/config";
import { rotateSigningKey } from "@/server/platform/integrations";
import { DEFAULT_AI_LIMITS } from "@/lib/ai-providers";
import { NotPlatformAdminError } from "@/server/platform/service";
import { askAssistant } from "@/server/assistant/service";
import { saveAssistantPreferences } from "@/server/tenancy/preferences";
import { createUser, makePlatformAdmin } from "../support/fixtures";
import { conn, school } from "../support/mobile-money";

afterAll(() => conn.close());

const admin = (async () => {
  const user = await createUser(conn.owner, "Integrations Admin");
  await makePlatformAdmin(conn.owner, user.id);
  return user;
})();

describe("platform integrations", () => {
  it("keep AI off until platform staff choose a provider, with its key sealed and every change recorded", async () => {
    const a = await admin;
    const someone = await createUser(conn.owner);
    const key = `gsk_test_${"x".repeat(30)}wxyz`;
    const settings = (over: Record<string, unknown> = {}) => ({
      enabled: true,
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      baseUrl: "",
      identifiableApproved: false,
      tasks: { assistant: true },
      ...over,
    });
    await expect(setAiApiKey(conn.app, someone.id, { provider: "groq", apiKey: key })).rejects.toThrow(
      NotPlatformAdminError,
    );
    // Switching on needs the provider set up: here, its key.
    await removeAiApiKey(conn.app, a.id, "groq");
    await expect(updateAiSettings(conn.app, a.id, settings())).rejects.toMatchObject({
      code: "ai_not_configured",
    });
    // A free provider can never be approved for identifiable data.
    await expect(
      updateAiSettings(conn.app, a.id, settings({ enabled: false, identifiableApproved: true })),
    ).rejects.toMatchObject({ code: "ai_settings_invalid", field: "identifiableApproved" });

    await setAiApiKey(conn.app, a.id, { provider: "groq", apiKey: key });
    const [row] = await conn.owner
      .select()
      .from(platformSecrets)
      .where(eq(platformSecrets.name, aiKeyName("groq")));
    expect(row!.sealed).not.toContain(key);
    expect(row!.hint).toBe("wxyz");
    await updateAiSettings(conn.app, a.id, settings());
    const config = await readAiConfig(conn.app);
    expect(config).toMatchObject({
      enabled: true,
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: key,
      identifiableApproved: false,
      tasks: { assistant: true },
    });
    expect((await getAiAdmin(conn.app, a.id)).key).toMatchObject({ source: "platform", hint: "wxyz" });

    // A paid provider can be approved, but only once chosen: changing provider withdraws the approval.
    await updateAiSettings(
      conn.app,
      a.id,
      settings({ enabled: false, provider: "anthropic", model: "claude-opus-5-5" }),
    );
    await updateAiSettings(
      conn.app,
      a.id,
      settings({
        enabled: false,
        provider: "anthropic",
        model: "claude-opus-5-5",
        identifiableApproved: true,
      }),
    );
    expect((await readAiConfig(conn.app)).identifiableApproved).toBe(true);
    await updateAiSettings(
      conn.app,
      a.id,
      settings({
        enabled: false,
        provider: "openai_compatible",
        model: "some-model",
        baseUrl: "https://example.test/v1",
        identifiableApproved: true,
      }),
    );
    expect((await readAiConfig(conn.app)).identifiableApproved).toBe(false);

    await expect(
      updateAiLimits(conn.app, a.id, { ...DEFAULT_AI_LIMITS, userPerMinute: 0 }),
    ).rejects.toMatchObject({ code: "ai_settings_invalid", field: "userPerMinute" });
    await updateAiLimits(conn.app, a.id, { ...DEFAULT_AI_LIMITS, schoolMonthlyTokens: 250_000 });
    expect((await readAiConfig(conn.app)).limits.schoolMonthlyTokens).toBe(250_000);

    // Row-level security: the app role cannot change secrets for a user who is not platform staff.
    await withUser(conn.app, someone.id, (tx) =>
      tx
        .update(platformSecrets)
        .set({ hint: "evil" })
        .where(eq(platformSecrets.name, aiKeyName("groq"))),
    );
    const [unchanged] = await conn.owner
      .select()
      .from(platformSecrets)
      .where(eq(platformSecrets.name, aiKeyName("groq")));
    expect(unchanged!.hint).toBe("wxyz");

    // Removing the key of the provider in use switches AI off; a school that turned the assistant on is told so.
    await updateAiSettings(conn.app, a.id, settings());
    await removeAiApiKey(conn.app, a.id, "groq");
    const after = await readAiConfig(conn.app);
    expect(after.enabled).toBe(process.env.AI_API_KEY ? true : false);
    const s = await school();
    await saveAssistantPreferences(conn.app, s.owner, { assistantEnabled: true, assistantShareNames: false });
    await updateAiSettings(conn.app, a.id, settings({ enabled: false, provider: "none", model: "" }));
    await expect(askAssistant(conn.app, s.owner, { question: "How are we doing?" })).rejects.toMatchObject({
      code: "assistant_not_configured",
    });
    const actions = (
      await withUser(conn.owner, a.id, (tx) =>
        tx.select({ action: platformEvents.action }).from(platformEvents),
      )
    ).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["ai.key_saved", "ai.settings_updated", "ai.limits_updated", "ai.key_removed"]),
    );
    await updateAiLimits(conn.app, a.id, DEFAULT_AI_LIMITS);
  });

  it("rotate signing keys without breaking records signed before", async () => {
    const a = await admin;
    const s = await school();
    const ama = (await s.add("Ama", s.classA)).id;
    const first = await rotateSigningKey(conn.app, a.id);
    const before = await exportLearnerRecord(conn.app, s.owner, ama);
    expect(before.signature.keyId).toBe(first);

    const second = await rotateSigningKey(conn.app, a.id);
    const after = await exportLearnerRecord(conn.app, s.owner, ama);
    expect(after.signature.keyId).toBe(second);
    expect(await verifyLearnerPackage(conn.app, before)).toMatchObject({ status: "valid" });
    expect(await verifyLearnerPackage(conn.app, after)).toMatchObject({ status: "valid" });

    const keys = await conn.owner.select().from(recordSigningKeys);
    expect(keys.find((k) => k.keyId === first)).toMatchObject({ status: "retired" });
    expect(keys.filter((k) => k.status === "active")).toHaveLength(1);
    // The private key is stored sealed, never as plain PKCS#8.
    expect(keys.find((k) => k.keyId === second)!.privateKeySealed).not.toMatch(/^MC4CAQAwBQYDK2Vw/);
    // A retired key cannot come back, and keys are never deleted.
    await expect(
      withUser(conn.app, a.id, (tx) =>
        tx
          .update(recordSigningKeys)
          .set({ status: "active", retiredAt: null })
          .where(eq(recordSigningKeys.keyId, first)),
      ),
    ).rejects.toThrow();
    // No delete policy: a delete removes nothing.
    await withUser(conn.app, a.id, (tx) =>
      tx.delete(recordSigningKeys).where(eq(recordSigningKeys.keyId, first)),
    ).catch(() => undefined);
    expect(
      (await conn.owner.select().from(recordSigningKeys).where(eq(recordSigningKeys.keyId, first))).length,
    ).toBe(1);
    await expect(rotateSigningKey(conn.app, (await createUser(conn.owner)).id)).rejects.toThrow(
      NotPlatformAdminError,
    );
  });
});
