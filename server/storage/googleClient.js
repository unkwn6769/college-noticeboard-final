import { google } from "googleapis";
import { findGoogleAccountForFile, updateGoogleAccessToken } from "./driveAccounts.js";
import crypto from "node:crypto";
import { pool } from "../db/database.js";

const DRIVE_CLIENT_CACHE_TTL_MS = 5 * 60 * 1000;
const driveClientCache = new Map();
const driveClientInflight = new Map();

function getAccountCacheKey(account) {
  return account?.connected_account_id
    ? String(account.connected_account_id)
    : null;
}

async function invalidateGoogleAccountAuthorization(accountId, reason = null) {
  if (!accountId) {
    return false;
  }

  const result = await pool.query(
    `
    UPDATE google_drive_accounts
    SET
      status = 'authorization_invalid',
      updated_at = NOW()
    WHERE id = $1
      AND status <> 'authorization_invalid'
    RETURNING id
    `,
    [accountId]
  );

  if (result.rowCount > 0) {
    console.warn(
      `[GOOGLE DRIVE] Account ${accountId} marked authorization_invalid${reason ? `: ${reason}` : ""}`
    );
  }

  return result.rowCount > 0;
}

function isAuthorizationInvalidError(error) {
  const status = error?.response?.status ?? error?.status ?? error?.code ?? null;
  const reason = error?.response?.data?.error?.errors?.[0]?.reason ?? error?.errors?.[0]?.reason ?? null;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = String(reason ?? error?.code ?? message ?? "").toLowerCase();

  if (status === 401) {
    return true;
  }

  if (
    status === 403 && (
      reason === "notAuthorized" ||
      reason === "invalidCredentials" ||
      reason === "invalid_grant" ||
      normalized.includes("invalid grant") ||
      normalized.includes("invalid credentials") ||
      normalized.includes("not authorized") ||
      normalized.includes("required scope")
    )
  ) {
    return true;
  }

  return false;
}

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

async function getConnectedGoogleAccounts() {
  const result = await pool.query(`
    SELECT
      id AS connected_account_id,
      email,
      client_id_encrypted,
      client_secret_encrypted,
      access_token_encrypted,
      refresh_token_encrypted,
      token_expires_at,
      redirect_uri
    FROM google_drive_accounts
    WHERE status = 'connected'
    ORDER BY email
  `);

  return result.rows;
}

async function createGoogleAuth(account) {
  if (
    !account.access_token_encrypted ||
    !account.refresh_token_encrypted
  ) {
    throw new Error(
      `Google account ${account.connected_account_id} has missing tokens`
    );
  }

  const auth = new google.auth.OAuth2(
    decryptText(account.client_id_encrypted),
    decryptText(account.client_secret_encrypted),
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
    try {
      const result = await auth.refreshAccessToken();
      const credentials = result.credentials;

      if (!credentials.access_token) {
        throw new Error(
          "Google token refresh returned no access token"
        );
      }

      await updateGoogleAccessToken(
        account.connected_account_id,
        encryptText(credentials.access_token),
        new Date(
          credentials.expiry_date ?? Date.now() + 3600_000
        )
      );

      auth.setCredentials(credentials);
    } catch (error) {
      if (isAuthorizationInvalidError(error)) {
        await invalidateGoogleAccountAuthorization(
          account.connected_account_id,
          error instanceof Error ? error.message : String(error)
        );
      }
      throw error;
    }
  }

  return auth;
}

export async function getGoogleDriveClientForAccount(account) {
  const cacheKey = getAccountCacheKey(account);

  if (!cacheKey) {
    const auth = await createGoogleAuth(account);

    return google.drive({
      version: "v3",
      auth,
    });
  }

  const now = Date.now();
  const cached = driveClientCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return cached.drive;
  }

  const inflight = driveClientInflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const promise = (async () => {
    const auth = await createGoogleAuth(account);

    const drive = google.drive({
      version: "v3",
      auth,
    });

    driveClientCache.set(cacheKey, {
      drive,
      expiresAt: Date.now() + DRIVE_CLIENT_CACHE_TTL_MS,
    });

    return drive;
  })();

  driveClientInflight.set(cacheKey, promise);

  try {
    return await promise;
  } finally {
    driveClientInflight.delete(cacheKey);
  }
}

export async function getConnectedGoogleDriveAccounts() {
  const accounts = await getConnectedGoogleAccounts();

  const results = await Promise.all(
    accounts.map(async (account) => {
      try {
        const drive = await getGoogleDriveClientForAccount(account);

        return {
          account,
          drive,
        };
      } catch (error) {
        // A single broken/partially-authorized account must not prevent
        // the admin account list or the healthy Drive accounts from loading.
        // Callers can still inspect the DB row and later reconnect/remove
        // the unhealthy account.
        console.error(
          `[GOOGLE DRIVE] Skipping account ${account.email ?? account.connected_account_id}:`,
          error instanceof Error ? error.message : error
        );

        return null;
      }
    })
  );

  return results.filter(Boolean);
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