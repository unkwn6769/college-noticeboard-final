import { pool } from "./db/database.js";
import { getGoogleDriveClientForAccount } from "./storage/googleClient.js";

function normalizeDriveFile(file, account) {
  return {
    fileId: String(file.id),
    name: file.name || "Untitled",
    mimeType: file.mimeType || "application/octet-stream",
    sizeBytes: file.size == null ? null : String(file.size),
    modifiedTime: file.modifiedTime || null,
    trashed: file.trashed === true,
    accountId: account.id,
    accountEmail: account.email,
    webViewLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
    parents: Array.isArray(file.parents) ? file.parents : [],
  };
}

async function getConnectedAccount(accountId) {
  const result = await pool.query(
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
      AND status = 'connected'
    LIMIT 1
    `,
    [accountId]
  );

  return result.rows[0] || null;
}

async function getManagedFileIds(accountId) {
  const result = await pool.query(
    `
    SELECT f.file_id
    FROM google_drive_file_accounts f
    WHERE f.account_id = $1
    `,
    [accountId]
  );

  return new Set(result.rows.map((row) => String(row.file_id)));
}

export async function listRecycleBin({ accountId = "" } = {}) {
  const accountResult = accountId
    ? await pool.query(
        `
        SELECT id, email, status
        FROM google_drive_accounts
        WHERE id = $1
        LIMIT 1
        `,
        [accountId]
      )
    : await pool.query(
        `
        SELECT id, email, status
        FROM google_drive_accounts
        WHERE status = 'connected'
        ORDER BY email
        `
      );

  const accounts = accountResult.rows;
  const results = [];

  for (const accountRow of accounts) {
    if (accountRow.status !== "connected") continue;

    const account = await getConnectedAccount(accountRow.id);
    if (!account) continue;

    const drive = await getGoogleDriveClientForAccount(account);
    const managedFileIds = await getManagedFileIds(account.id);

    let pageToken = undefined;

    do {
      const response = await drive.files.list({
        q: "'me' in owners and trashed = true",
        pageSize: 1000,
        pageToken,
        spaces: "drive",
        fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,trashed,webViewLink,parents)",
        orderBy: "modifiedTime desc",
      });

      for (const file of response.data.files || []) {
        if (file.id && managedFileIds.has(String(file.id))) {
          results.push(normalizeDriveFile(file, account));
        }
      }

      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);
  }

  results.sort((a, b) => {
    const left = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
    const right = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
    return right - left || a.name.localeCompare(b.name);
  });

  return {
    files: results,
    total: results.length,
  };
}

async function getManagedFileContext(fileId) {
  const result = await pool.query(
    `
    SELECT
      f.file_id,
      f.account_id,
      a.email,
      a.status,
      r.id AS resource_id,
      r.name,
      r.is_available,
      r.storage_status
    FROM google_drive_file_accounts f
    INNER JOIN google_drive_accounts a
      ON a.id = f.account_id
    INNER JOIN resources r
      ON r.storage_key = f.file_id
    WHERE f.file_id = $1
    LIMIT 1
    `,
    [fileId]
  );

  return result.rows[0] || null;
}

export async function restoreRecycleBinFile(fileId) {
  const context = await getManagedFileContext(fileId);
  if (!context) {
    const error = new Error("Managed Drive file not found");
    error.status = 404;
    throw error;
  }

  if (context.status !== "connected") {
    const error = new Error("Drive account is not connected");
    error.status = 409;
    throw error;
  }

  const account = await getConnectedAccount(context.account_id);
  if (!account) {
    const error = new Error("Drive account is not available");
    error.status = 409;
    throw error;
  }

  const drive = await getGoogleDriveClientForAccount(account);

  const current = await drive.files.get({
    fileId,
    fields: "id,name,trashed,mimeType,size,modifiedTime,webViewLink,parents",
  });

  if (!current.data.trashed) {
    return normalizeDriveFile(current.data, account);
  }

  const restored = await drive.files.update({
    fileId,
    requestBody: { trashed: false },
    fields: "id,name,trashed,mimeType,size,modifiedTime,webViewLink,parents",
  });

  await pool.query(
    `
    UPDATE resources
    SET
      is_available = TRUE,
      storage_status = 'synced',
      updated_at = NOW()
    WHERE storage_key = $1
    `,
    [fileId]
  );

  return normalizeDriveFile(restored.data, account);
}

export async function permanentlyDeleteRecycleBinFile(fileId) {
  const context = await getManagedFileContext(fileId);
  if (!context) {
    const error = new Error("Managed Drive file not found");
    error.status = 404;
    throw error;
  }

  if (context.status !== "connected") {
    const error = new Error("Drive account is not connected");
    error.status = 409;
    throw error;
  }

  const account = await getConnectedAccount(context.account_id);
  if (!account) {
    const error = new Error("Drive account is not available");
    error.status = 409;
    throw error;
  }

  const drive = await getGoogleDriveClientForAccount(account);

  const current = await drive.files.get({
    fileId,
    fields: "id,trashed",
  });

  if (!current.data.trashed) {
    const error = new Error("File is no longer in the recycle bin");
    error.status = 409;
    throw error;
  }

  await drive.files.delete({ fileId });

  await pool.query(
    `
    DELETE FROM google_drive_file_accounts
    WHERE file_id = $1
    `,
    [fileId]
  );

  await pool.query(
    `
    UPDATE resources
    SET
      is_available = FALSE,
      storage_status = 'failed',
      updated_at = NOW()
    WHERE storage_key = $1
    `,
    [fileId]
  );

  return {
    fileId,
    accountId: context.account_id,
    accountEmail: context.email,
    permanentlyDeleted: true,
  };
}
