import { pool } from "../db/database.js";

export async function findGoogleAccountForFile(fileId) {
  const result = await pool.query(
    `
    SELECT
      a.id AS connected_account_id,
      a.client_id_encrypted,
      a.client_secret_encrypted,
      a.access_token_encrypted,
      a.refresh_token_encrypted,
      a.token_expires_at,
      a.redirect_uri
    FROM google_drive_file_accounts f
    JOIN google_drive_accounts a
      ON a.id = f.account_id
    WHERE f.file_id = $1
      AND a.status = 'connected'
    LIMIT 1
    `,
    [fileId]
  );

  return result.rows[0] ?? null;
}

export async function updateGoogleAccessToken(
  accountId,
  accessTokenEncrypted,
  tokenExpiresAt
) {
  await pool.query(
    `
    UPDATE google_drive_accounts
    SET
      access_token_encrypted = $1,
      token_expires_at = $2,
      updated_at = NOW()
    WHERE id = $3
    `,
    [
      accessTokenEncrypted,
      tokenExpiresAt,
      accountId,
    ]
  );
}