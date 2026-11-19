import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  edubridgePaystack,
  invoicePaymentsFromEnv,
  invoiceReferenceFromWebhook,
  parseInvoicePaymentReference,
} from "@/server/billing/online-payments";
import {
  fillTemplate,
  isStopReply,
  parseWhatsAppWebhook,
  verifyWhatsAppSignature,
  WHATSAPP_KINDS,
  WHATSAPP_TEMPLATES,
  whatsappCloudProvider,
} from "@/server/notifications/whatsapp";

const url = (path: string) => `https://edubridge.example${path}`;

describe("WhatsApp templates", () => {
  it("cover every WhatsApp kind and follow Meta's template rules", () => {
    for (const kind of WHATSAPP_KINDS) expect(WHATSAPP_TEMPLATES[kind], kind).toBeTruthy();
    for (const [key, t] of Object.entries(WHATSAPP_TEMPLATES)) {
      expect(t!.name, key).toMatch(/^edubridge_[a-z_]+$/);
      // A body neither starts nor ends with a variable.
      expect(t!.body.trimStart().startsWith("{{"), key).toBe(false);
      expect(/\{\{\d+\}\}[.!?]?$/.test(t!.body.trimEnd()), key).toBe(false);
      const placeholders = new Set(t!.body.match(/\{\{\d+\}\}/g));
      const params = t!.params(
        {
          schoolName: "Accra Hills\nAcademy",
          studentFirstName: "Kofi",
          amountPesewas: 50_000,
          balancePesewas: 120_000,
          receiptNumber: "R-0042",
          termLabel: "Term 2",
          title: "Sports day",
          deadline: "Fri, 20 Nov 2026",
          when: "Sat, 14 Nov 2026, 10:00",
          location: "the hall",
          days: 3,
          kind: "consecutive",
          balanceLinkToken: "tok",
        },
        url,
      );
      expect(params.length, key).toBe(placeholders.size);
      // No newlines in values (Meta refuses them).
      for (const p of params) expect(p, key).not.toMatch(/\n/);
      expect(fillTemplate(t!.body, params), key).not.toMatch(/\{\{/);
    }
  });

  it("read like the SMS they replace", () => {
    const t = WHATSAPP_TEMPLATES.payment_receipt!;
    const text = fillTemplate(
      t.body,
      t.params(
        {
          schoolName: "Accra Hills",
          studentFirstName: "Kofi",
          amountPesewas: 50_000,
          receiptNumber: "R-1",
          balancePesewas: 0,
        },
        url,
      ),
    );
    expect(text).toBe(
      "Payment received by Accra Hills: GH₵500.00 for Kofi, receipt R-1. Fees are fully paid. The receipt is in the EduBridge parent view.",
    );
    const absence = WHATSAPP_TEMPLATES.absence_alert!;
    expect(
      fillTemplate(
        absence.body,
        absence.params({ schoolName: "A", studentFirstName: "Esi", days: 1, kind: "term_total" }, url),
      ),
    ).toBe(
      "Attendance notice from A: Esi has been absent for 1 school day this term. Please contact the school.",
    );
  });
});

describe("WhatsApp webhook", () => {
  it("accepts only bodies signed with the app secret", () => {
    const body = JSON.stringify({ entry: [] });
    const good = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
    expect(verifyWhatsAppSignature(body, good, "secret")).toBe(true);
    expect(verifyWhatsAppSignature(body + " ", good, "secret")).toBe(false);
    expect(verifyWhatsAppSignature(body, good, "other")).toBe(false);
    expect(verifyWhatsAppSignature(body, null, "secret")).toBe(false);
    expect(verifyWhatsAppSignature(body, "sha256=zz", "secret")).toBe(false);
    expect(verifyWhatsAppSignature(body, good, "")).toBe(false);
  });

  it("reads statuses and text replies, and ignores anything else", () => {
    const parsed = parseWhatsAppWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  { id: "wamid.1", status: "delivered", timestamp: "1794300000" },
                  { id: "wamid.2", status: "failed", timestamp: "1794300001", errors: [{ code: 131026 }] },
                  { id: "wamid.3", status: "deleted" },
                ],
                messages: [
                  { from: "233241234567", type: "text", text: { body: "STOP" } },
                  { from: "not-a-number", text: { body: "hi" } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(parsed.statuses.map((s) => [s.messageId, s.status, s.errorCode])).toEqual([
      ["wamid.1", "delivered", null],
      ["wamid.2", "failed", 131026],
    ]);
    expect(parsed.replies).toEqual([{ from: "+233241234567", text: "STOP" }]);
    expect(parseWhatsAppWebhook(null)).toEqual({ statuses: [], replies: [] });
    expect(["stop", " Unsubscribe ", "STOP ALL"].every(isStopReply)).toBe(true);
    expect(isStopReply("please stop sending at night")).toBe(false);
  });
});

describe("WhatsApp Cloud API provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends an approved template with the body values, and reports Meta's error code on refusal", async () => {
    const fetchMock = vi.fn(async () => Response.json({ messages: [{ id: "wamid.ok" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = whatsappCloudProvider({ accessToken: "token", phoneNumberId: "123", version: "v24.0" });
    const result = await provider.sendTemplate({
      to: "+233241234567",
      template: "edubridge_announcement",
      language: "en",
      params: ["Accra Hills", "Sports day", "https://x/p"],
      text: "",
    });
    expect(result).toEqual({ messageId: "wamid.ok" });
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe("https://graph.facebook.com/v24.0/123/messages");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer token");
    expect(JSON.parse(String(init.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "233241234567",
      type: "template",
      template: {
        name: "edubridge_announcement",
        language: { code: "en" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Accra Hills" },
              { type: "text", text: "Sports day" },
              { type: "text", text: "https://x/p" },
            ],
          },
        ],
      },
    });
    fetchMock.mockImplementationOnce(async () =>
      Response.json({ error: { code: 131026, message: "x" } }, { status: 400 }),
    );
    await expect(
      provider.sendTemplate({ to: "+233241234567", template: "t", language: "en", params: [], text: "" }),
    ).rejects.toThrow(/400, code 131026/);
  });
});

describe("EduBridge invoice payments", () => {
  it("read only their own references, and Paystack webhooks signed with EduBridge's key", () => {
    const tenant = "11111111-1111-4111-8111-111111111111";
    const payment = "22222222-2222-4222-8222-222222222222";
    expect(parseInvoicePaymentReference(`EBI.${tenant}.${payment}`)).toEqual({
      tenantId: tenant,
      paymentId: payment,
    });
    expect(parseInvoicePaymentReference(`${tenant}.${payment}`)).toBeNull();
    expect(
      invoiceReferenceFromWebhook({
        event: "charge.success",
        data: { reference: `EBI.${tenant}.${payment}` },
      }),
    ).toBe(`EBI.${tenant}.${payment}`);
    expect(
      invoiceReferenceFromWebhook({
        event: "charge.failed",
        data: { reference: `EBI.${tenant}.${payment}` },
      }),
    ).toBeNull();
    const provider = edubridgePaystack({ secretKey: "sk_test_x", currencies: ["GHS"] });
    const body = '{"event":"charge.success"}';
    const signature = createHmac("sha512", "sk_test_x").update(body).digest("hex");
    expect(provider.verifyWebhook(body, signature)).toBe(true);
    expect(provider.verifyWebhook(body, signature.replace(/.$/, "0"))).toBe(signature.endsWith("0"));
    expect(provider.verifyWebhook(body, null)).toBe(false);
  });

  it("stay off in production without EduBridge's key, and with a live key until it is approved", () => {
    expect(invoicePaymentsFromEnv({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBeNull();
    expect(
      invoicePaymentsFromEnv({
        NODE_ENV: "production",
        EDUBRIDGE_PAYSTACK_SECRET_KEY: "sk_live_x",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      invoicePaymentsFromEnv({
        NODE_ENV: "production",
        EDUBRIDGE_PAYSTACK_SECRET_KEY: "sk_live_x",
        EDUBRIDGE_PAYSTACK_ALLOW_LIVE: "true",
      } as NodeJS.ProcessEnv)?.name,
    ).toBe("paystack");
    expect(invoicePaymentsFromEnv({ NODE_ENV: "development" } as NodeJS.ProcessEnv)?.name).toBe("mock");
  });
});
