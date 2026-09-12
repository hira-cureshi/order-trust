// encryption.js — encrypts sensitive values (currently: each shop's Shopify
// access token) before they're stored in the database. Fixes a real gap
// flagged during the protected-customer-data review: access tokens were
// sitting in plain text, meaning anyone with access to the database file
// would have real access to a connected store. Uses AES-256-GCM, the
// standard, well-vetted authenticated-encryption algorithm built into
// Node's crypto module — no extra dependency needed.

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";

function getKey() {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with: openssl rand -hex 32, and add it to your environment variables."
    );
  }
  // Accepts a 64-character hex string (32 bytes) as recommended in .env.example.
  return Buffer.from(secret, "hex");
}

function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const key = getKey();
  const iv = crypto.randomBytes(12); // GCM standard IV size
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store iv + authTag + ciphertext together, base64-encoded, so a single
  // string column can hold everything needed to decrypt it later.
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function decrypt(stored) {
  if (!stored) return null;
  const key = getKey();
  const data = Buffer.from(stored, "base64");
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

module.exports = { encrypt, decrypt };
