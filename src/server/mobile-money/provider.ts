import type { MobileMoneyNetwork } from "@/lib/mobile-money";

/**
 * A Mobile Money collection provider: asks a payer to approve a payment on their phone, and reports
 * the result. Implemented by Paystack (paystack.ts, chosen 2026-11-06) and by the mock used in tests.
 *
 * The provider's word is never taken from a callback alone: the service always asks `getStatus` and
 * checks the amount and currency before recording a payment.
 */
export interface MobileMoneyProvider {
  /** Stored with each request, so its status is always checked with the provider that sent it. */
  name: string;
  /** True when no real money moves (shown to staff as test mode). */
  testMode: boolean;
  /** In test mode: how to try it (which numbers approve, decline...), shown to staff. */
  testHint?: string;
  requestPayment(request: CollectionRequest): Promise<CollectionStarted>;
  getStatus(ref: CollectionRef): Promise<CollectionStatus>;
  /**
   * Checks that a callback really comes from the provider (signature) and says which request it is
   * about. Returns null when it is not genuine. Its status, if any, is ignored: see getStatus.
   */
  verifyCallback(callback: IncomingCallback): CallbackRef | null;
}

export interface IncomingCallback {
  headers: Headers;
  rawBody: string;
}

/** Which request a callback is about; at least one reference is set. */
export interface CallbackRef {
  reference: string | null;
  providerReference: string | null;
  /**
   * The school, for providers that send every callback to one address (Paystack): read from the
   * reference EduBridge gave the payment. Null when the callback URL names the school instead.
   */
  tenantId?: string | null;
}

export interface CollectionRequest {
  /** The school the payment is for. */
  tenantId: string;
  /** Our request id; providers that accept a client reference receive this. */
  reference: string;
  amountPesewas: number;
  currency: "GHS";
  /** E.164, e.g. +233241234567. */
  msisdn: string;
  network: MobileMoneyNetwork;
  /** Shown to the payer with the prompt. */
  payerMessage: string;
  /** Where the provider should send its callback, when it supports per-request callback URLs. */
  callbackUrl: string | null;
  /**
   * The school's own account with the provider (a Paystack subaccount code), so the money settles to the
   * school directly and EduBridge never holds it (D-07). Null when not set up.
   */
  settlementAccount: string | null;
}

export interface CollectionStarted {
  /** The provider's own id for the request, when it issues one. */
  providerReference: string | null;
}

export interface CollectionRef {
  tenantId: string;
  reference: string;
  providerReference: string | null;
}

export type CollectionStatus =
  | { state: "pending" }
  | {
      state: "successful";
      amountPesewas: number;
      currency: string;
      /** The network's transaction id, printed on the receipt. */
      transactionId: string;
      completedAt: Date | null;
    }
  | { state: "failed"; reason: string }
  /** The provider has no record of the request (it was never received). */
  | { state: "not_found" };

/** A provider call that failed. The message is safe to store and show (no secrets or raw responses). */
export class ProviderError extends Error {
  constructor(
    message: string,
    /** True only when the provider definitely refused the request, so no prompt can have been sent. */
    readonly rejected = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
