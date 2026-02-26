import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

const ALGO = "aes-256-gcm";
// Static, public salt — not a secret. Exists purely to prevent the raw env
// var string from being used directly as a key, and to version the derivation
// so rotating TOKEN_ENCRYPTION_KEY invalidates old ciphertexts cleanly.
const SALT = "shieldkit-token-v1";

// Cached after first call — scrypt is intentionally CPU-hard.
let _derivedKey: Buffer | null = null;

function getKey(): Buffer {
  if (_derivedKey) return _derivedKey;
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY environment variable must be set and at least 32 characters long"
    );
  }
  _derivedKey = scryptSync(secret, SALT, 32); // 256 bits
  return _derivedKey;
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 *
 * Returns a single string in the format:
 *   <hex_iv>:<hex_authTag>:<hex_ciphertext>
 *
 * This is self-contained — all three parts are required for decryption and
 * are safe to store in a single TEXT/VARCHAR column.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12); // 96-bit IV — NIST recommendation for GCM
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag(); // 128-bit authentication tag
  return [
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}

/**
 * Decrypts a value produced by encrypt().
 *
 * Throws if:
 * - The format is invalid (not three colon-separated hex strings)
 * - The authentication tag does not match (ciphertext has been tampered with)
 */
export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error(
      `Invalid ciphertext format: expected 3 colon-separated parts, got ${parts.length}`
    );
  }
  const [ivHex, authTagHex, encHex] = parts;
  const decipher = createDecipheriv(
    ALGO,
    getKey(),
    Buffer.from(ivHex, "hex")
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encHex, "hex")),
    decipher.final(), // throws on authTag mismatch — correct behaviour
  ]);
  return decrypted.toString("utf8");
}
