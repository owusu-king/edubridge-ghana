import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypts small secrets at rest (two-step verification seeds, platform API keys, record-signing keys)
 * with AES-256-GCM. The key comes from MFA_ENCRYPTION_KEY (32 bytes, base64).
 *
 * Rotating it: set the new key as MFA_ENCRYPTION_KEY and the old one as MFA_ENCRYPTION_KEY_PREVIOUS, so
 * values sealed with either open; then run `npm run keys:rotate` to seal every stored value with the new
 * key, and remove MFA_ENCRYPTION_KEY_PREVIOUS. See docs/DEPLOYMENT-AND-OPERATIONS.md.
 */
const VERSION = "v1";

function decode(name: string, raw: string): Buffer {
  const decoded = Buffer.from(raw, "base64");
  if (decoded.length !== 32) throw new Error(`${name} must be 32 bytes, base64 encoded.`);
  return decoded;
}

function key(): Buffer {
  const raw = process.env.MFA_ENCRYPTION_KEY;
  if (!raw) throw new Error("MFA_ENCRYPTION_KEY is not set.");
  return decode("MFA_ENCRYPTION_KEY", raw);
}

function previousKey(): Buffer | null {
  const raw = process.env.MFA_ENCRYPTION_KEY_PREVIOUS;
  return raw ? decode("MFA_ENCRYPTION_KEY_PREVIOUS", raw) : null;
}

export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function openWith(k: Buffer, iv: string, tag: string, ciphertext: string): string {
  const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString(
    "utf8",
  );
}

/** Opens a sealed value with the current key, or during a rotation the previous one. */
export function open(sealed: string): string {
  const [version, iv, tag, ciphertext] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error("Unrecognised sealed value.");
  try {
    return openWith(key(), iv, tag, ciphertext);
  } catch (error) {
    const previous = previousKey();
    if (!previous) throw error;
    return openWith(previous, iv, tag, ciphertext);
  }
}

/** The value sealed again with the current key (for rotation); unchanged in meaning. */
export function reseal(sealed: string): string {
  return seal(open(sealed));
}
