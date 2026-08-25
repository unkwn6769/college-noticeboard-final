import { google } from "googleapis";
import { findGoogleAccountForFile, updateGoogleAccessToken } from "./driveAccounts.js";
import crypto from "node:crypto";

function decryptText(value) {
  const key = crypto
    .createHash("sha256")
    .update(process.env.TOKEN_ENCRYPTION_KEY)
    .digest();

  const [ivRaw, tagRaw, encryptedRaw] = value.split(":");

  if (!ivRaw || !tagRaw || !encryptedRaw) {
    throw new Error("Invalid encrypted token");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivRaw, "base64")
  );

  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function encryptText(value) {
  const key = crypto
    .createHash("sha256")
    .update(process.env.TOKEN_ENCRYPTION_KEY)
    .digest();

  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    key,
    iv
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

export async function getGoogleDriveClient(fileId) {
  const account = await findGoogleAccountForFile(fileId);

  if (!account) {
    throw new Error(`No Google account found for file ${fileId}`);
  }

  if (
    !account.access_token_encrypted ||
    !account.refresh_token_encrypted
  ) {
    throw new Error("Google account tokens are missing");
  }

  const clientId = decryptText(account.client_id_encrypted);
  const clientSecret = decryptText(account.client_secret_encrypted);

  const auth = new google.auth.OAuth2(
    clientId,
    clientSecret,
    account.redirect_uri
  );

  const expiresAt = account.token_expires_at
    ? new Date(account.token_expires_at).getTime()
    : 0;

  auth.setCredentials({
    access_token: decryptText(account.access_token_encrypted),
    refresh_token: decryptText(account.refresh_token_encrypted),
    expiry_date: expiresAt,
  });

  if (expiresAt && expiresAt < Date.now() + 60_000) {
    const result = await auth.refreshAccessToken();
    const credentials = result.credentials;

    if (!credentials.access_token) {
      throw new Error("Google token refresh returned no access token");
    }

    const encryptedAccessToken = encryptText(
      credentials.access_token
    );

    const newExpiry = new Date(
      credentials.expiry_date ?? Date.now() + 3600_000
    );

    await updateGoogleAccessToken(
      account.connected_account_id,
      encryptedAccessToken,
      newExpiry
    );

    auth.setCredentials(credentials);
  }

  return google.drive({
    version: "v3",
    auth,
  });
}