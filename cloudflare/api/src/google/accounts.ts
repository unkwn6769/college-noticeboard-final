import { withDatabase } from "../db/postgres";

export type GoogleDriveAccount = {
  id: string;
  email: string;
  client_id_encrypted: string;
  client_secret_encrypted: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  token_expires_at: string | null;
  redirect_uri: string | null;
  status: string;
};

export async function getGoogleDriveAccount(
  env: Env,
  accountId: string,
): Promise<GoogleDriveAccount | null> {
  return withDatabase(env, async (client) => {
    const result = await client.query<GoogleDriveAccount>(
      `
      SELECT
        id,
        email,
        client_id_encrypted,
        client_secret_encrypted,
        access_token_encrypted,
        refresh_token_encrypted,
        token_expires_at,
        redirect_uri,
        status
      FROM google_drive_accounts
      WHERE id = $1
      LIMIT 1
      `,
      [accountId],
    );

    return result.rows[0] ?? null;
  });
}
