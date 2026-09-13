import { strict as assert } from "node:assert";
import { test } from "node:test";
import crypto from "node:crypto";
import { decryptText, encryptText } from "./encryption";

const secret = "college-noticeboard-test-secret";
const plaintext = "cross-runtime-token-test";

function oldNodeEncrypt(value: string, secretValue: string): string {
  const key = crypto
    .createHash("sha256")
    .update(secretValue)
    .digest();

  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    key,
    iv,
  );

  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

test("new decrypt reads legacy Node AES-256-GCM ciphertext", async () => {
  const legacyCiphertext = oldNodeEncrypt(
    plaintext,
    secret,
  );

  const decrypted = await decryptText(
    legacyCiphertext,
    secret,
  );

  assert.equal(decrypted, plaintext);
});

test("new encrypt/decrypt round trips", async () => {
  const encrypted = await encryptText(
    plaintext,
    secret,
  );

  const decrypted = await decryptText(
    encrypted,
    secret,
  );

  assert.equal(decrypted, plaintext);
});
