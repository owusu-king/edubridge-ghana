import "server-only";
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { DomainError } from "../errors";

/**
 * Signing learner records (Transfer Passport) with Ed25519. A record is signed over its canonical JSON
 * (keys sorted, no spaces), so anyone holding the package and EduBridge's public key can check that it was
 * issued by EduBridge for that school and has not been changed by a single character.
 *
 * Keys: RECORD_SIGNING_KEY (Ed25519 private key, PKCS#8, base64 DER or PEM) with RECORD_SIGNING_KEY_ID.
 * Earlier public keys stay trusted for verification through RECORD_SIGNING_PUBLIC_KEYS, a JSON object of
 * key id to SPKI (base64 DER or PEM), so keys can be rotated without invalidating issued records. Outside
 * production a fixed development key is used when none is set; production never trusts it.
 */

export const PACKAGE_FORMAT = "edubridge.learner-record";
export const PACKAGE_VERSION = 1;
const DEV_KEY_ID = "dev-1";

/** JSON with object keys sorted at every level and no whitespace: the exact bytes that are signed. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const production = () => process.env.NODE_ENV === "production";

function devPrivateKey(): KeyObject {
  // PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410), around a fixed seed: for development and tests only.
  const seed = createHash("sha256").update("edubridge development record signing key").digest();
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

function parsePrivate(value: string): KeyObject {
  return value.includes("BEGIN")
    ? createPrivateKey(value)
    : createPrivateKey({ key: Buffer.from(value, "base64"), format: "der", type: "pkcs8" });
}

function parsePublic(value: string): KeyObject {
  return value.includes("BEGIN")
    ? createPublicKey(value)
    : createPublicKey({ key: Buffer.from(value, "base64"), format: "der", type: "spki" });
}

/** The key new records are signed with. */
export function signingKey(): { keyId: string; privateKey: KeyObject } {
  const configured = process.env.RECORD_SIGNING_KEY;
  if (configured) {
    const keyId = process.env.RECORD_SIGNING_KEY_ID;
    if (!keyId) throw new Error("RECORD_SIGNING_KEY_ID must be set with RECORD_SIGNING_KEY.");
    return { keyId, privateKey: parsePrivate(configured) };
  }
  if (production())
    throw new DomainError(
      "signing_not_configured",
      "Learner records cannot be issued yet: EduBridge's signing key is not set up.",
    );
  return { keyId: DEV_KEY_ID, privateKey: devPrivateKey() };
}

/** Every public key records may be verified with, by key id. */
export function trustedKeys(): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const configured = process.env.RECORD_SIGNING_KEY;
  if (configured && process.env.RECORD_SIGNING_KEY_ID)
    keys.set(process.env.RECORD_SIGNING_KEY_ID, createPublicKey(parsePrivate(configured)));
  const earlier = process.env.RECORD_SIGNING_PUBLIC_KEYS;
  if (earlier)
    for (const [id, value] of Object.entries(JSON.parse(earlier) as Record<string, string>))
      keys.set(id, parsePublic(value));
  if (!production() && !keys.has(DEV_KEY_ID)) keys.set(DEV_KEY_ID, createPublicKey(devPrivateKey()));
  return keys;
}

/** Public keys for anyone verifying records outside EduBridge (published at /api/v1/passport/keys). */
export function publishedKeys(): {
  keyId: string;
  algorithm: "Ed25519";
  publicKey: string;
  development: boolean;
}[] {
  return [...trustedKeys()].map(([keyId, key]) => ({
    keyId,
    algorithm: "Ed25519" as const,
    publicKey: key.export({ format: "der", type: "spki" }).toString("base64"),
    development: keyId === DEV_KEY_ID,
  }));
}

export interface SignedPackage {
  format: typeof PACKAGE_FORMAT;
  version: typeof PACKAGE_VERSION;
  record: Record<string, unknown>;
  signature: { algorithm: "Ed25519"; keyId: string; value: string };
}

export function signRecord(record: Record<string, unknown>): { pkg: SignedPackage; sha256: string } {
  const { keyId, privateKey } = signingKey();
  const bytes = canonicalJson(record);
  const value = sign(null, Buffer.from(bytes, "utf8"), privateKey).toString("base64url");
  return {
    pkg: {
      format: PACKAGE_FORMAT,
      version: PACKAGE_VERSION,
      record,
      signature: { algorithm: "Ed25519", keyId, value },
    },
    sha256: sha256Hex(bytes),
  };
}

export type SignatureCheck =
  | { status: "valid"; keyId: string; sha256: string; record: Record<string, unknown>; development: boolean }
  | { status: "unsigned"; sha256: string; record: Record<string, unknown> }
  | { status: "invalid"; reason: string };

/** Checks a package's form and signature (not whether it was revoked: see verifyLearnerPackage). */
export function checkSignature(input: unknown): SignatureCheck {
  if (!input || typeof input !== "object")
    return { status: "invalid", reason: "This is not a learner record." };
  const pkg = input as Partial<SignedPackage> & { signature?: unknown };
  if (pkg.format !== PACKAGE_FORMAT || pkg.version !== PACKAGE_VERSION)
    return {
      status: "invalid",
      reason: "This is not an EduBridge learner record (format or version not recognised).",
    };
  if (!pkg.record || typeof pkg.record !== "object" || Array.isArray(pkg.record))
    return { status: "invalid", reason: "The record is missing." };
  const bytes = canonicalJson(pkg.record);
  if (pkg.signature === undefined || pkg.signature === null)
    return { status: "unsigned", sha256: sha256Hex(bytes), record: pkg.record };
  const sig = pkg.signature as Partial<SignedPackage["signature"]>;
  if (sig.algorithm !== "Ed25519" || typeof sig.keyId !== "string" || typeof sig.value !== "string")
    return { status: "invalid", reason: "The signature is malformed." };
  const key = trustedKeys().get(sig.keyId);
  if (!key) return { status: "invalid", reason: "It was signed with a key EduBridge does not recognise." };
  let ok = false;
  try {
    ok = verify(null, Buffer.from(bytes, "utf8"), key, Buffer.from(sig.value, "base64url"));
  } catch {
    ok = false;
  }
  if (!ok)
    return {
      status: "invalid",
      reason: "The signature does not match: the record has been changed since it was issued.",
    };
  return {
    status: "valid",
    keyId: sig.keyId,
    sha256: sha256Hex(bytes),
    record: pkg.record,
    development: sig.keyId === DEV_KEY_ID,
  };
}
