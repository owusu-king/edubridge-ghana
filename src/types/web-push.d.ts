/**
 * The parts of web-push 4 that EduBridge uses (the package ships no types; @types/web-push describes v3).
 * See src/server/notifications/push.ts.
 */
declare module "web-push" {
  export interface PushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }
  export interface SendResult {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  }
  export interface RequestOptions {
    vapidDetails?: { subject: string; publicKey: string; privateKey: string };
    TTL?: number;
    urgency?: "very-low" | "low" | "normal" | "high";
    timeout?: number;
  }
  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer | null,
    options?: RequestOptions,
  ): Promise<SendResult>;
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
  export class WebPushError extends Error {
    statusCode: number;
    body: string;
    endpoint: string;
  }
}
