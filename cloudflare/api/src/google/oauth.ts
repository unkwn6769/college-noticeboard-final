import { decryptText, encryptText } from "../auth/encryption";
import { withDatabase } from "../db/postgres";

type DriveAccount = {
  id: string;
  email: string;
  client_id_encrypted: string;
  client_secret_encrypted: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  token_expires_at: string | null;
};

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

export async function getDriveAccessToken(
  env: Env,
  account: DriveAccount,
): Promise<string> {
  const secret = env.TOKEN_ENCRYPTION_KEY;

  if (!account.access_token_encrypted) {
    throw new Error(`Google account ${account.id} has no access token`);
  }

  if (!account.refresh_token_encrypted) {
    throw new Error(`Google account ${account.id} has no refresh token`);
  }

  const accessToken = await decryptText(
    account.access_token_encrypted,
    secret,
  );

  const expiresAt = account.token_expires_at
    ? new Date(account.token_expires_at).getTime()
    : 0;

  if (!expiresAt || expiresAt >= Date.now() + 60_000) {
    return accessToken;
  }

  const clientId = await decryptText(
    account.client_id_encrypted,
    secret,
  );

  const clientSecret = await decryptText(
    account.client_secret_encrypted,
    secret,
  );

  const refreshToken = await decryptText(
    account.refresh_token_encrypted,
    secret,
  );

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const response = await fetch(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: {
        "content-type":
          "application/x-www-form-urlencoded",
      },
      body,
    },
  );

  const payload =
    (await response.json()) as GoogleTokenResponse;

  if (!response.ok || !payload.access_token) {
    throw new Error(
      `Google token refresh failed: ${
        payload.error_description ||
        payload.error ||
        `HTTP ${response.status}`
      }`,
    );
  }

  const newExpiresAt = new Date(
    Date.now() +
      (payload.expires_in ?? 3600) * 1000,
  );

  const encryptedAccessToken = await encryptText(
    payload.access_token,
    secret,
  );

  await withDatabase(env, async (client) => {
    await client.query(
      `
      UPDATE google_drive_accounts
      SET
        access_token_encrypted = $1,
        token_expires_at = $2,
        updated_at = NOW()
      WHERE id = $3
      `,
      [
        encryptedAccessToken,
        newExpiresAt,
        account.id,
      ],
    );
  });

  return payload.access_token;
}
