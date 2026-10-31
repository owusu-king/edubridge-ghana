import { afterEach, describe, expect, it, vi } from "vitest";
import {
  arkeselProvider,
  brevoProvider,
  DeliveryError,
  providersFromEnv,
} from "@/server/notifications/providers";
import { TEMPLATES } from "@/server/notifications/templates";

afterEach(() => vi.unstubAllGlobals());

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

const email = { to: "ama@example.test", subject: "Hi", html: "<p>Hi</p>", text: "Hi" };

describe("Brevo", () => {
  it("sends with the api-key header and returns the message id", async () => {
    const fetch = mockFetch(201, { messageId: "<abc@brevo>" });
    const provider = brevoProvider({
      apiKey: "key-123",
      fromEmail: "no-reply@edubridge.test",
      fromName: "EduBridge",
      sandbox: false,
    });
    expect(await provider.sendEmail(email)).toEqual({ messageId: "<abc@brevo>" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("key-123");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      sender: { email: "no-reply@edubridge.test" },
      to: [{ email: "ama@example.test" }],
      subject: "Hi",
    });
    expect(body.headers).toBeUndefined();
  });

  it("uses Brevo's sandbox header when enabled", async () => {
    const fetch = mockFetch(201, { messageId: "x" });
    await brevoProvider({ apiKey: "k", fromEmail: "a@b.test", fromName: "E", sandbox: true }).sendEmail(
      email,
    );
    expect(
      JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).headers,
    ).toEqual({ "X-Sib-Sandbox": "drop" });
  });

  it("reports failures without leaking content; 400 is permanent", async () => {
    mockFetch(400, { code: "invalid_parameter", message: "bad email" });
    const provider = brevoProvider({ apiKey: "k", fromEmail: "a@b.test", fromName: "E", sandbox: false });
    await expect(provider.sendEmail(email)).rejects.toMatchObject({
      message: "Brevo responded 400 (invalid_parameter)",
      permanent: true,
    });
    mockFetch(503, {});
    await expect(provider.sendEmail(email)).rejects.toMatchObject({ permanent: false });
  });
});

describe("Arkesel", () => {
  it("sends to international numbers without '+'", async () => {
    const fetch = mockFetch(200, { status: "success", data: [{ recipient: "233244000000", id: "msg-1" }] });
    const provider = arkeselProvider({ apiKey: "ark", senderId: "EduBridge", sandbox: true });
    expect(await provider.sendSms({ to: "+233244000000", text: "Code 123456" })).toEqual({
      messageId: "msg-1",
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sms.arkesel.com/api/v2/sms/send");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("ark");
    expect(JSON.parse(init.body as string)).toEqual({
      sender: "EduBridge",
      message: "Code 123456",
      recipients: ["233244000000"],
      sandbox: true,
    });
  });

  it("treats anything but a success status as a failure", async () => {
    mockFetch(200, { status: "error", message: "Insufficient balance" });
    await expect(
      arkeselProvider({ apiKey: "a", senderId: "E", sandbox: false }).sendSms({ to: "+233", text: "x" }),
    ).rejects.toBeInstanceOf(DeliveryError);
  });
});

describe("provider selection", () => {
  it("uses configured providers and refuses to silently drop messages in production", async () => {
    expect(providersFromEnv({ NODE_ENV: "development" } as NodeJS.ProcessEnv).email.name).toBe("log");
    const configured = providersFromEnv({
      NODE_ENV: "production",
      BREVO_API_KEY: "k",
      EMAIL_FROM: "a@b.test",
      ARKESEL_API_KEY: "s",
    } as NodeJS.ProcessEnv);
    expect([configured.email.name, configured.sms.name]).toEqual(["brevo", "arkesel"]);
    const unconfigured = providersFromEnv({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    await expect(unconfigured.email.sendEmail(email)).rejects.toThrow("BREVO_API_KEY is not configured.");
  });
});

describe("templates", () => {
  it("escapes data in HTML and links to the app", () => {
    process.env.APP_URL = "https://app.edubridge.test";
    const rendered = TEMPLATES.invitation({
      schoolName: "A&B <School>",
      roles: ["Teacher"],
      token: "tok",
      expiresAt: "2026-11-07T00:00:00Z",
    });
    expect(rendered.html).toContain("A&amp;B &lt;School&gt;");
    expect(rendered.html).not.toContain("<School>");
    expect(rendered.text).toContain("https://app.edubridge.test/invite/tok");
    const reset = TEMPLATES.password_reset({ name: "Ama", token: "r1", expiresMinutes: 30 });
    expect(reset.text).toContain("https://app.edubridge.test/reset-password/r1");
    expect(reset.subject).toBe("Reset your EduBridge password");
  });
});
