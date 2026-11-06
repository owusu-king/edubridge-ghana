import type { MobileMoneyNetwork } from "@/lib/mobile-money";

/**
 * A Mobile Money collection provider: asks a payer to approve a payment on their phone, and reports
 * the result. Real adapters (MTN MoMo, Telecel Cash, AT Money, or an aggregator) implement this once
 * their documentation and sandbox access are available; until then only the mock exists.
 *
 * The provider's word is never taken from a callback alone: the service always asks `getStatus` and
 * checks the amount and currency before recording a payment.
 */
export interface MobileMoneyProvider {
  /** Stored with each request, so its status is always checked with the provider that sent it. */
  name: string;
  /** True when no real money moves (shown to staff as test mode). */
  testMode: boolean;
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
}

export interface CollectionRequest {
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
}

export interface CollectionStarted {
  /** The provider's own id for the request, when it issues one. */
  providerReference: string | null;
}

export interface CollectionRef {
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
