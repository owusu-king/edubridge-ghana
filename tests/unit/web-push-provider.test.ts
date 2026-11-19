import { describe, expect, it, vi } from "vitest";

const sendNotification = vi.fn();
vi.mock("web-push", () => ({ sendNotification }));

const { DeliveryError, providersFromEnv, webPushProvider } = await import("@/server/notifications/providers");

const message = {
  subscription: { endpoint: "https://push.example.test/abc", keys: { p256dh: "p", auth: "a" } },
  payload: { title: "Kpone Ridge", body: "A new announcement. Open to read it.", url: "/p/kpone-ridge/news" },
};
const provider = webPushProvider({ publicKey: "pub", privateKey: "priv", subject: "mailto:support@x.test" });
const failWith = (statusCode: number) =>
  sendNotification.mockRejectedValueOnce(Object.assign(new Error("x"), { statusCode }));

describe("web push provider", () => {
  it("sends the payload as JSON with the VAPID details and a day to live", async () => {
    sendNotification.mockResolvedValueOnce({ statusCode: 201, body: "", headers: { location: "msg-1" } });
    expect(await provider.sendPush(message)).toEqual({ messageId: "msg-1" });
    expect(sendNotification).toHaveBeenCalledWith(
      message.subscription,
      JSON.stringify(message.payload),
      expect.objectContaining({
        TTL: 86_400,
        vapidDetails: { publicKey: "pub", privateKey: "priv", subject: "mailto:support@x.test" },
      }),
    );
  });

  it("marks a subscription the push service no longer has as gone (never retried)", async () => {
    for (const status of [404, 410]) {
      failWith(status);
      const error = await provider.sendPush(message).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DeliveryError);
      expect(error).toMatchObject({ permanent: true, gone: true });
    }
  });

  it("does not retry a refused message, and retries service errors", async () => {
    failWith(413);
    expect(await provider.sendPush(message).catch((e: unknown) => e)).toMatchObject({
      permanent: true,
      gone: false,
    });
    failWith(503);
    expect(await provider.sendPush(message).catch((e: unknown) => e)).toMatchObject({ permanent: false });
  });

  it("is never what stops email or SMS when it is misconfigured", () => {
    const providers = providersFromEnv({
      NODE_ENV: "production",
      VAPID_PUBLIC_KEY: "pub",
    } as NodeJS.ProcessEnv);
    expect(providers.push.name).toBe("unconfigured");
    expect(providers.sms.name).toBe("unconfigured");
    const dev = providersFromEnv({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
    expect(dev.push.name).toBe("log");
  });
});
