import { pool } from "./db/database.js";
import {
  getGoogleDriveClientForAccount,
} from "./storage/googleClient.js";
import { Transform } from "node:stream";

const MAX_TRANSIENT_RETRIES = 3;
const RETRY_DELAY_MS = 3000;
const ITEM_LEASE_DURATION_MS = 5 * 60 * 1000;
const ITEM_HEARTBEAT_INTERVAL_MS = 60 * 1000;
const itemLeaseHeartbeats = new Map();
const itemLeaseHeartbeatErrors = new Map();
const itemAbortControllers = new Map();

export class FencedWorkerError extends Error {
  constructor(itemId) {
    super(`Worker fenced on item ${itemId}`);
    this.name = "FencedWorkerError";
  }
}

export function isFencedWorkerError(error) {
  let current = error;
  const seen = new Set();

  while (current && !seen.has(current)) {
    seen.add(current);

    if (current instanceof FencedWorkerError) {
      return true;
    }

    if (current.name === "FencedWorkerError") {
      return true;
    }

    current = current.cause;
  }

  return false;
}

function isAbortError(error) {
  return Boolean(
    error && (
      error.name === "AbortError" ||
      error.code === "ABORT_ERR" ||
      error.name === "CanceledError" ||
      error.code === "ECONNABORTED"
    )
  );
}

function assertFencedUpdate(result, itemId) {
  if (result.rowCount === 0) {
    throw new FencedWorkerError(itemId);
  }

  return result;
}

const transientRetryCounts = new Map();

const TARGET_ACCOUNTS_CACHE_TTL_MS = 15_000;
const QUOTA_CACHE_TTL_MS = 10_000;

let targetAccountsCache = {
  expiresAt: 0,
  rows: null,
};

const quotaCache = new Map();
const quotaInflight = new Map();

function toBigInt(value, label = "value") {
  if (typeof value === "bigint") {
    return value;
  }

  if (value === null || value === undefined || value === "") {
    return 0n;
  }

  try {
    return BigInt(String(value));
  } catch (error) {
    throw new TypeError(
      `Invalid integer ${label}: ${String(value)}`
    );
  }
}

/*
 * Google Drive account quotas in this application are small enough to fit
 * safely inside JavaScript's integer range (for example, 15 GB accounts).
 * Keep quota-selection arithmetic in Number space so a third-party API value
 * cannot accidentally enter a BigInt expression as a Number. Durable DB
 * byte counters and streaming progress remain BigInt elsewhere.
 */
function toSafeByteNumber(value, label = "bytes") {
  const bigintValue = toBigInt(value, label);
  if (bigintValue < 0n) {
    throw new RangeError(`Negative ${label}: ${String(value)}`);
  }

  if (bigintValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `${label} exceeds JavaScript safe integer range`
    );
  }

  return Number(bigintValue);
}

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

export async function heartbeatItemLease(itemId, leaseGeneration) {
  const result = await pool.query(
    `
    UPDATE google_drive_account_migration_items
    SET lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond')
    WHERE id = $1
      AND status = 'running'
      AND lease_generation = $2
      AND lease_expires_at > NOW()
    RETURNING id, lease_expires_at, lease_generation, status
    `,
    [itemId, leaseGeneration, ITEM_LEASE_DURATION_MS]
  );

  if (result.rowCount === 0) {
    throw new FencedWorkerError(itemId);
  }

  return result.rows[0];
}

export function getItemAbortController(itemId) {
  let controller = itemAbortControllers.get(itemId);
  if (!controller) {
    controller = new AbortController();
    itemAbortControllers.set(itemId, controller);
  }
  return controller;
}

export function abortItemTransfer(itemId) {
  const controller = itemAbortControllers.get(itemId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }
  itemAbortControllers.delete(itemId);
}

function cleanupItemTransferState(itemId) {
  stopItemLeaseHeartbeat(itemId);
  itemLeaseHeartbeatErrors.delete(itemId);

  const controller = itemAbortControllers.get(itemId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
  }
  itemAbortControllers.delete(itemId);
}

export function startItemLeaseHeartbeat(itemId, leaseGeneration, abortController = getItemAbortController(itemId)) {
  stopItemLeaseHeartbeat(itemId);

  if (abortController) {
    itemAbortControllers.set(itemId, abortController);
  }

  const timer = setInterval(() => {
    heartbeatItemLease(itemId, leaseGeneration).catch((error) => {
      itemLeaseHeartbeatErrors.set(itemId, error);
      abortItemTransfer(itemId);
      clearInterval(timer);
      itemLeaseHeartbeats.delete(itemId);
    });
  }, ITEM_HEARTBEAT_INTERVAL_MS);

  timer.unref?.();
  itemLeaseHeartbeats.set(itemId, timer);

  return timer;
}

export function stopItemLeaseHeartbeat(itemId) {
  const timer = itemLeaseHeartbeats.get(itemId);
  if (timer) {
    clearInterval(timer);
    itemLeaseHeartbeats.delete(itemId);
  }
  itemLeaseHeartbeatErrors.delete(itemId);
}

function getGoogleErrorStatus(error) {
  return (
    error?.response?.status ??
    error?.status ??
    error?.code ??
    null
  );
}

function getGoogleErrorReason(error) {
  return (
    error?.response?.data?.error?.errors?.[0]?.reason ??
    error?.errors?.[0]?.reason ??
    null
  );
}

export function isAuthorizationInvalidGoogleError(error) {
  const status = getGoogleErrorStatus(error);
  const reason = getGoogleErrorReason(error);
  const code = error?.code;
  const message = error instanceof Error
    ? error.message
    : String(error ?? "");

  const normalized = String(
    reason ?? code ?? message ?? ""
  ).toLowerCase();

  if (status === 401) {
    return true;
  }

  if (
    status === 403 && (
      reason === "notAuthorized" ||
      reason === "invalidCredentials" ||
      reason === "invalid_grant" ||
      reason === "invalid_client" ||
      normalized.includes("invalid grant") ||
      normalized.includes("invalid credentials") ||
      normalized.includes("not authorized") ||
      normalized.includes("invalid_client") ||
      normalized.includes("unauthorized_client") ||
      normalized.includes("required scope")
    )
  ) {
    return true;
  }

  return false;
}

export async function markAccountAuthorizationInvalid(accountId, errorMessage = null) {
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
      `[MIGRATION] Marked Google Drive account ${accountId} as authorization_invalid${errorMessage ? `: ${errorMessage}` : ""}`
    );
  }

  return result.rowCount > 0;
}

export function classifyGoogleError(error) {
  const status = getGoogleErrorStatus(error);
  const reason = getGoogleErrorReason(error);
  const code = error?.code;

  if (isAuthorizationInvalidGoogleError(error)) {
    return {
      type: "authorization_invalid",
      reason: reason ?? code ?? `HTTP ${status}`,
    };
  }

  /*
   * These failures are safe to retry because the Google API or the
   * underlying network may recover without any application change.
   */
  if (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    [
      "rateLimitExceeded",
      "userRateLimitExceeded",
      "backendError",
      "internalError",
    ].includes(reason) ||
    [
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNABORTED",
      "EAI_AGAIN",
      "UND_ERR_CONNECT_TIMEOUT",
    ].includes(code)
  ) {
    return {
      type: "transient",
      reason: reason ?? code ?? `HTTP ${status}`,
    };
  }

  /*
   * Drive quota exhaustion is different from a permanent failure.
   * Another connected destination account may become available later,
   * so the item should return to the storage-waiting state.
   */
  if (
    reason === "storageQuotaExceeded" ||
    reason === "quotaExceeded" ||
    status === 507
  ) {
    return {
      type: "storage",
      reason: reason ?? `HTTP ${status}`,
    };
  }

  /*
   * Missing source/target objects, invalid requests, and authorization or
   * permission failures cannot be fixed by blindly retrying the same call.
   */
  if (
    status === 400 ||
    status === 404 ||
    status === 405 ||
    status === 409 ||
    status === 410 ||
    status === 412 ||
    reason === "insufficientFilePermissions" ||
    reason === "forbidden" ||
    reason === "fileNotFound" ||
    reason === "notFound" ||
    reason === "invalid"
  ) {
    return {
      type: "permanent",
      reason: reason ?? `HTTP ${status}`,
    };
  }

  return {
    type: "unknown",
    reason: reason ?? code ?? (status ? `HTTP ${status}` : "unknown"),
  };
}

function isTransientGoogleError(error) {
  return classifyGoogleError(error).type === "transient";
}

async function getRetryCount(itemId) {
  const result = await pool.query(
    `SELECT retry_count FROM google_drive_account_migration_items WHERE id = $1 LIMIT 1`,
    [itemId]
  );
  return Number(result.rows[0]?.retry_count ?? 0);
}

export async function incrementRetryCount(itemId, leaseGeneration) {
  const result = await pool.query(
    `
    UPDATE google_drive_account_migration_items
    SET retry_count = retry_count + 1,
        last_retry_at = NOW(),
        updated_at = NOW()
    WHERE id = $1 AND lease_generation = $2
    RETURNING retry_count
    `,
    [itemId, leaseGeneration]
  );
  assertFencedUpdate(result, itemId);
  return Number(result.rows[0].retry_count);
}

export async function clearRetryCount(itemId, leaseGeneration) {
  const result = await pool.query(
    `
    UPDATE google_drive_account_migration_items
    SET retry_count = 0,
        last_retry_at = NULL,
        next_retry_at = NULL,
        updated_at = NOW()
    WHERE id = $1 AND lease_generation = $2
    `,
    [itemId, leaseGeneration]
  );
  assertFencedUpdate(result, itemId);
}

export async function getMigrationStatus(migrationId) {
  const result = await pool.query(
    `
    SELECT id, status, cancel_requested, total_files, completed_files, failed_files
    FROM google_drive_account_migrations
    WHERE id = $1
    LIMIT 1
    `,
    [migrationId]
  );

  return result.rows[0] ?? null;
}

async function getMigration(migrationId) {
  const result = await pool.query(
    `
    SELECT
      m.id,
      m.source_account_id,
      m.target_account_id,
      m.status,
      m.cancel_requested,
      m.total_files,
      m.completed_files,
      m.failed_files
    FROM google_drive_account_migrations m
    WHERE m.id = $1
    LIMIT 1
    `,
    [migrationId]
  );

  return result.rows[0] ?? null;
}

const accountCache = new Map();
const accountInflight = new Map();
const ACCOUNT_CACHE_TTL_MS = 5_000;

async function getAccount(accountId) {
  const cacheKey = String(accountId);
  const now = Date.now();
  const cached = accountCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.account;
  }

  const inflight = accountInflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const promise = (async () => {
    const result = await pool.query(
    `
    SELECT
      id AS connected_account_id,
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
    [accountId]
  );

    const account = result.rows[0] ?? null;
    accountCache.set(cacheKey, {
      account,
      expiresAt: Date.now() + ACCOUNT_CACHE_TTL_MS,
    });
    return account;
  })();

  accountInflight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    accountInflight.delete(cacheKey);
  }
}

const targetAccountsInflight = { promise: null };

async function getConnectedTargetAccounts(
  preferredAccountId
) {
  const now = Date.now();
  let rows = targetAccountsCache.rows;

  if (!rows || targetAccountsCache.expiresAt <= now) {
    if (!targetAccountsInflight.promise) {
      targetAccountsInflight.promise = (async () => {
        const result = await pool.query(
          `
          SELECT
            id AS connected_account_id,
            email,
            client_id_encrypted,
            client_secret_encrypted,
            access_token_encrypted,
            refresh_token_encrypted,
            token_expires_at,
            redirect_uri,
            status
          FROM google_drive_accounts
          WHERE status = 'connected'
          ORDER BY email
          `
        );
        const freshRows = result.rows;
        targetAccountsCache = {
          expiresAt: Date.now() + TARGET_ACCOUNTS_CACHE_TTL_MS,
          rows: freshRows,
        };
        return freshRows;
      })();
    }

    try {
      rows = await targetAccountsInflight.promise;
    } finally {
      targetAccountsInflight.promise = null;
    }
  }

  return [...rows].sort((a, b) => {
    const aPreferred = a.connected_account_id === preferredAccountId ? 0 : 1;
    const bPreferred = b.connected_account_id === preferredAccountId ? 0 : 1;
    if (aPreferred !== bPreferred) return aPreferred - bPreferred;
    return a.email.localeCompare(b.email);
  });
}

async function getFreeBytes(account) {
  const drive =
    await getGoogleDriveClientForAccount(
      account
    );

  const cacheKey = String(account.connected_account_id);
  const now = Date.now();
  const cached = quotaCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return {
      drive,
      freeBytes: cached.freeBytes,
    };
  }

  const existing = quotaInflight.get(cacheKey);

  if (existing) {
    const freeBytes = await existing;
    return {
      drive,
      freeBytes,
    };
  }

  const refreshPromise = (async () => {
    const about = await drive.about.get({
      fields: "storageQuota",
    });

    const quota = about.data.storageQuota;

    if (
      !quota?.limit ||
      quota?.usage === undefined
    ) {
      quotaCache.set(cacheKey, {
        freeBytes: null,
        expiresAt: Date.now() + QUOTA_CACHE_TTL_MS,
      });

      return null;
    }

    const freeBytes =
      toBigInt(quota.limit, "quota.limit") -
      toBigInt(quota.usage, "quota.usage");

    quotaCache.set(cacheKey, {
      freeBytes,
      expiresAt: Date.now() + QUOTA_CACHE_TTL_MS,
    });

    return freeBytes;
  })();

  quotaInflight.set(cacheKey, refreshPromise);

  try {
    const freeBytes = await refreshPromise;
    return {
      drive,
      freeBytes,
    };
  } finally {
    quotaInflight.delete(cacheKey);
  }
}

async function acquireTargetAccountLock(accountId) {
  if (!accountId) {
    return null;
  }

  const accountKey = String(accountId);
  const client = await pool.connect();
  let acquired = false;

  try {
    /*
     * Use a blocking advisory lock for the short reservation critical
     * section. Lock contention must never be interpreted as
     * "no storage": it only means another worker is currently
     * reserving this account. PostgreSQL releases this lock automatically if
     * the owning connection dies, so a blocking wait cannot create a stale
     * lock after a process crash.
     */
    await client.query(
      `
      SELECT pg_advisory_lock(
        hashtextextended($1, 0)
      )
      `,
      [accountKey]
    );

    acquired = true;

    const accountResult = await client.query(
      `
      SELECT
        id AS connected_account_id,
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
      [accountId]
    );

    const account = accountResult.rows[0] ?? null;

    if (!account) {
      await client.query(
        `
        SELECT pg_advisory_unlock(
          hashtextextended($1, 0)
        )
        `,
        [accountKey]
      );
      acquired = false;
      client.release();
      return null;
    }

    return {
      client,
      accountId,
      account,
    };
  } catch (error) {
    if (acquired) {
      try {
        await client.query(
          `
          SELECT pg_advisory_unlock(
            hashtextextended($1, 0)
          )
          `,
          [accountKey]
        );
      } catch (unlockError) {
        console.error(
          '[MIGRATION] Failed to release target-account lock after acquisition error:',
          unlockError instanceof Error
            ? unlockError.message
            : unlockError
        );
      }
    }

    client.release();
    throw error;
  }
}

async function releaseTargetAccountLock(lock) {
  if (!lock?.client) {
    return;
  }

  try {
    await lock.client.query(
      `
      SELECT pg_advisory_unlock(
        hashtextextended($1, 0)
      )
      `,
      [String(lock.accountId)]
    );
  } catch (error) {
    console.error(
      "[MIGRATION] Failed to release target-account advisory lock:",
      error instanceof Error
        ? error.message
        : error
    );
  } finally {
    lock.client.release();
  }
}


async function chooseTargetAccount(
  migration,
  item,
  requiredBytes
) {
  /*
   * Target selection is deliberately split into two phases:
   *
   *   1. Read current quota snapshots outside the advisory lock.
   *   2. Take a short advisory lock only for the database reservation
   *      critical section.
   *
   * The snapshot cache stores promises so concurrent workers can share an
   * in-flight quota request. Every consumer MUST await the promise before
   * reading freeBytes. Quota-selection arithmetic uses safe Numbers; durable
   * byte counters elsewhere remain BigInt.
   */
  const required = toSafeByteNumber(
    requiredBytes,
    "requiredBytes"
  );

  const snapshotPromises = new Map();

  const loadSnapshot = (account) => {
    if (!account?.connected_account_id) {
      return Promise.resolve(null);
    }

    const accountId = String(
      account.connected_account_id
    );

    const cached = snapshotPromises.get(accountId);
    if (cached) {
      return cached;
    }

    const promise = getFreeBytes(account)
      .then(({ drive, freeBytes }) => ({
        account,
        drive,
        freeBytes:
          freeBytes === null || freeBytes === undefined
            ? null
            : toSafeByteNumber(
                freeBytes,
                "quota.freeBytes"
              ),
      }))
      .catch((error) => {
        snapshotPromises.delete(accountId);
        throw error;
      });

    snapshotPromises.set(accountId, promise);
    return promise;
  };

  const getResolvedSnapshot = async (accountId) => {
    if (!accountId) {
      return null;
    }

    const promise = snapshotPromises.get(
      String(accountId)
    );

    return promise ? await promise : null;
  };

  const tryReservedAccount = async (
    accountId,
    snapshot = null
  ) => {
    if (!accountId || accountId === migration.source_account_id) {
      return null;
    }

    const resolvedSnapshot =
      snapshot ?? await getResolvedSnapshot(accountId);

    const accountFromList =
      resolvedSnapshot?.account ?? await getAccount(accountId);

    if (
      !accountFromList ||
      accountFromList.status !== "connected"
    ) {
      return null;
    }

    const quotaSnapshot =
      resolvedSnapshot ?? await loadSnapshot(accountFromList);

    if (
      !quotaSnapshot ||
      quotaSnapshot.freeBytes === null ||
      quotaSnapshot.freeBytes === undefined
    ) {
      return null;
    }

    const lock = await acquireTargetAccountLock(accountId);

    try {
      const account = lock?.account;

      if (!lock || !account || account.status !== "connected") {
        return null;
      }

      const reservationResult = await lock.client.query(
        `
        SELECT COALESCE(SUM(reserved_bytes), 0)::numeric AS reserved_bytes
        FROM google_drive_account_migration_items
        WHERE target_account_id = $1
          AND status = 'running'
          AND reserved_bytes > 0
          AND id <> $2
        `,
        [account.connected_account_id, item.id]
      );

      const reserved = toSafeByteNumber(
        reservationResult.rows[0]?.reserved_bytes ?? 0,
        "reserved_bytes"
      );
      const free = toSafeByteNumber(
        quotaSnapshot.freeBytes,
        "quota.freeBytes"
      );

      const availableBytes = free - reserved;

      if (availableBytes < required) {
        return null;
      }

      const updateResult = await lock.client.query(
        `
        UPDATE google_drive_account_migration_items
        SET
          target_account_id = $1,
          reserved_bytes = $2,
          updated_at = NOW()
        WHERE id = $3
          AND status = 'running'
          AND lease_generation = $4
        `,
        [
          account.connected_account_id,
          required.toString(),
          item.id,
          item.lease_generation,
        ]
      );

      if (updateResult.rowCount !== 1) {
        throw new Error(
          `Failed to persist target account reservation for migration item ${item.id}`
        );
      }

      return {
        account,
        drive: quotaSnapshot.drive,
        freeBytes: free,
        lock,
      };
    } finally {
      if (lock) {
        await releaseTargetAccountLock(lock);
      }
    }
  };

  const accounts = await getConnectedTargetAccounts(
    migration.target_account_id
  );

  const eligibleAccounts = accounts.filter(
    (account) =>
      account.connected_account_id !==
      migration.source_account_id
  );

  /*
   * Refresh candidate quotas in parallel. getFreeBytes() itself is also
   * single-flight per account, so multiple migration workers share the same
   * short-lived Drive quota snapshot.
   */
  await Promise.all(
    eligibleAccounts.map((account) =>
      loadSnapshot(account)
    )
  );

  /*
   * Prefer an already-assigned target account first. This keeps resumed work
   * on its durable destination whenever capacity is available.
   */
  if (item.target_account_id) {
    const assignedSnapshot =
      await getResolvedSnapshot(
        item.target_account_id
      );

    const assigned = await tryReservedAccount(
      item.target_account_id,
      assignedSnapshot
    );

    if (assigned) {
      return assigned;
    }
  }

  /* Prefer the migration's requested target next. */
  if (
    migration.target_account_id &&
    migration.target_account_id !==
      migration.source_account_id
  ) {
    const preferredSnapshot =
      await getResolvedSnapshot(
        migration.target_account_id
      );

    const preferred = await tryReservedAccount(
      migration.target_account_id,
      preferredSnapshot
    );

    if (preferred) {
      return preferred;
    }
  }

  const candidates = [];

  for (const account of eligibleAccounts) {
    if (
      account.connected_account_id ===
      migration.target_account_id
    ) {
      continue;
    }

    const snapshot = await getResolvedSnapshot(
      account.connected_account_id
    );

    if (
      snapshot?.freeBytes !== null &&
      snapshot?.freeBytes !== undefined
    ) {
      const freeBytes = toSafeByteNumber(
        snapshot.freeBytes,
        "candidate.freeBytes"
      );

      if (freeBytes >= required) {
        candidates.push({
          account,
          snapshot,
          freeBytes,
        });
      }
    }
  }

  candidates.sort((a, b) => {
    if (a.freeBytes > b.freeBytes) return -1;
    if (a.freeBytes < b.freeBytes) return 1;
    return a.account.email.localeCompare(b.account.email);
  });

  for (const candidate of candidates) {
    const selected = await tryReservedAccount(
      candidate.account.connected_account_id,
      candidate.snapshot
    );

    if (selected) {
      return selected;
    }
  }

  return null;
}

export async function claimNextItem(migrationId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
      SELECT
        id,
        migration_id,
        source_file_id,
        target_file_id,
        target_account_id,
        size_bytes,
        bytes_transferred,
        transfer_phase,
        target_recovery_required,
        reconciliation_deadline,
        started_at,
        lease_generation,
        error_message
      FROM google_drive_account_migration_items
      WHERE migration_id = $1
        AND status IN ('pending', 'reconciling')
        AND (next_retry_at IS NULL OR next_retry_at <= NOW())
      ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
      `,
      [migrationId]
    );

    if (result.rows.length === 0) {
      await client.query("COMMIT");
      return null;
    }

    const item = result.rows[0];

    const updateResult = await client.query(
      `
      UPDATE google_drive_account_migration_items
      SET
        status = 'running',
        lease_generation = lease_generation + 1,
        lease_expires_at = NOW() + INTERVAL '5 minutes',
        reserved_bytes = 0,
        started_at = NOW(),
        finished_at = NULL,
        bytes_transferred = CASE WHEN target_file_id IS NOT NULL THEN bytes_transferred ELSE 0 END,
        speed_bytes_per_second = 0,
        transfer_phase = CASE
          WHEN target_file_id IS NOT NULL THEN 'verifying'
          WHEN status = 'reconciling' THEN 'reconciling'
          ELSE 'downloading'
        END,
        reconciliation_deadline = CASE WHEN status = 'reconciling' THEN reconciliation_deadline ELSE NULL END,
        updated_at = NOW(),
        error_message = NULL
      WHERE id = $1
        AND (
          lease_expires_at IS NULL
          OR lease_expires_at <= NOW()
          OR status IN ('pending', 'reconciling')
        )
      RETURNING
        id,
        migration_id,
        source_file_id,
        target_file_id,
        target_account_id,
        size_bytes,
        bytes_transferred,
        transfer_phase,
        target_recovery_required,
        reconciliation_deadline,
        started_at,
        status,
        lease_generation
      `,
      [item.id]
    );

    await client.query("COMMIT");

    return updateResult.rows[0] ?? null;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch { }

    throw error;
  } finally {
    client.release();
  }
}

export async function markItemFailed(itemId, leaseGeneration, errorMessage) {
  const result = await pool.query(
    `
    UPDATE google_drive_account_migration_items
    SET
      status = 'failed',
      reserved_bytes = 0,
      transfer_phase = 'failed',
      error_message = $1,
      finished_at = NOW(),
      updated_at = NOW()
    WHERE id = $2 AND lease_generation = $3
    `,
    [errorMessage, itemId, leaseGeneration]
  );
  assertFencedUpdate(result, itemId);
}

export async function requeueItemAfterStorageWait(
  itemId,
  leaseGeneration,
  errorMessage
) {
  const result = await pool.query(
    `
    UPDATE google_drive_account_migration_items
    SET
      status = 'pending',
      reserved_bytes = 0,
      error_message = $1,
      started_at = NULL,
      finished_at = NULL,
      bytes_transferred = CASE WHEN target_file_id IS NOT NULL THEN bytes_transferred ELSE 0 END,
      transfer_phase = CASE WHEN target_file_id IS NOT NULL THEN 'verifying' ELSE 'pending' END,
      next_retry_at = NOW() + INTERVAL '30 seconds',
      updated_at = NOW()
    WHERE id = $2 AND lease_generation = $3
    `,
    [errorMessage, itemId, leaseGeneration]
  );
  assertFencedUpdate(result, itemId);
}

export async function requeueItemAfterTransientFailure(
  itemId,
  leaseGeneration,
  errorMessage,
  delayMs
) {
  const result = await pool.query(
    `
    UPDATE google_drive_account_migration_items
    SET
      status = 'pending',
      reserved_bytes = 0,
      error_message = $1,
      started_at = NULL,
      finished_at = NULL,
      bytes_transferred = CASE WHEN target_file_id IS NOT NULL THEN bytes_transferred ELSE 0 END,
      transfer_phase = CASE WHEN target_file_id IS NOT NULL THEN 'verifying' ELSE 'pending' END,
      next_retry_at = NOW() + ($3 * INTERVAL '1 millisecond'),
      updated_at = NOW()
    WHERE id = $2 AND lease_generation = $4
    `,
    [errorMessage, itemId, delayMs, leaseGeneration]
  );
  assertFencedUpdate(result, itemId);
}

export async function markItemCompleted(
  itemId,
  leaseGeneration,
  targetFileId
) {
  const result = await pool.query(
    `
    UPDATE google_drive_account_migration_items
    SET
      status = 'completed',
      target_file_id = $1,
      reserved_bytes = 0,
      bytes_transferred = size_bytes,
      speed_bytes_per_second = 0,
      transfer_phase = 'completed',
      finished_at = NOW(),
      updated_at = NOW(),
      error_message = NULL
    WHERE id = $2 AND lease_generation = $3
    `,
    [targetFileId, itemId, leaseGeneration]
  );
  assertFencedUpdate(result, itemId);
}

async function incrementCompleted(migrationId) {
  await pool.query(
    `
    UPDATE google_drive_account_migrations
    SET
      completed_files = completed_files + 1,
      updated_at = NOW()
    WHERE id = $1
    `,
    [migrationId]
  );
}

async function incrementFailed(
  migrationId,
  errorMessage
) {
  await pool.query(
    `
    UPDATE google_drive_account_migrations
    SET
      failed_files = failed_files + 1,
      error_message = $2,
      updated_at = NOW()
    WHERE id = $1
    `,
    [migrationId, errorMessage]
  );
}

async function updateCurrentFile(
  migrationId,
  fileId
) {
  await pool.query(
    `
    UPDATE google_drive_account_migrations
    SET
      current_file_id = $2,
      updated_at = NOW()
    WHERE id = $1
    `,
    [migrationId, fileId]
  );
}

async function finishMigrationIfComplete(
  migrationId
) {
  /*
   * The item rows are the source of truth. Recompute the counters here
   * instead of relying only on incrementCompleted()/incrementFailed().
   * That makes completion/failure convergence safe across concurrent workers
   * and across a crash between item finalization and counter persistence.
   */
  await pool.query(
    `
    WITH counts AS (
      SELECT
        COUNT(*) FILTER (WHERE status = 'completed')::bigint AS completed_count,
        COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed_count
      FROM google_drive_account_migration_items
      WHERE migration_id = $1
    )
    UPDATE google_drive_account_migrations m
    SET
      completed_files = counts.completed_count,
      failed_files = counts.failed_count,
      status = CASE
        WHEN counts.failed_count > 0 THEN 'failed'
        WHEN counts.completed_count >= m.total_files THEN 'completed'
        ELSE m.status
      END,
      finished_at = CASE
        WHEN counts.failed_count > 0
          OR counts.completed_count >= m.total_files
        THEN COALESCE(m.finished_at, NOW())
        ELSE m.finished_at
      END,
      updated_at = NOW()
    FROM counts
    WHERE m.id = $1
      AND m.status IN ('pending', 'running', 'waiting_for_storage')
    `,
    [migrationId]
  );
}

async function getTargetFileById(
  targetDrive,
  targetFileId,
  migrationItemId,
  abortController = getItemAbortController(migrationItemId)
) {
  try {
    const response =
      await targetDrive.files.get({
        fileId: targetFileId,
        fields:
          "id,name,size,mimeType,appProperties,trashed",
      }, {
        signal: abortController?.signal,
      });

    if (response.data?.trashed) {
      return null;
    }

    const marker =
      response.data?.appProperties
        ?.college_noticeboard_migration_item;

    if (marker !== migrationItemId) {
      throw new Error(
        `Persisted target file ${targetFileId} does not belong to migration item ${migrationItemId}; refusing to create another copy`
      );
    }

    return response.data ?? null;
  } catch (error) {
    const status =
      getGoogleErrorStatus(error);

    if (status === 404) {
      return null;
    }

    throw error;
  }
}

async function persistTargetFileId(
  itemId,
  leaseGeneration,
  targetFileId
) {
  const result = await pool.query(
    `
    UPDATE google_drive_account_migration_items
    SET
      target_file_id = $1,
      target_recovery_required = FALSE,
      updated_at = NOW()
    WHERE id = $2 AND lease_generation = $3
    `,
    [targetFileId, itemId, leaseGeneration]
  );
  assertFencedUpdate(result, itemId);
}

async function persistRecoveredTargetProgress(
  itemId,
  leaseGeneration,
  sizeBytes,
  { clearRecoveryRequired = false } = {}
) {
  const result = await pool.query(
    `
    UPDATE google_drive_account_migration_items
    SET
      size_bytes = $1,
      bytes_transferred = $1,
      transfer_phase = 'verifying',
      target_recovery_required = CASE
        WHEN $4::boolean THEN FALSE
        ELSE target_recovery_required
      END,
      updated_at = NOW()
    WHERE id = $2 AND lease_generation = $3
    `,
    [
      String(sizeBytes),
      itemId,
      leaseGeneration,
      clearRecoveryRequired,
    ]
  );
  assertFencedUpdate(result, itemId);
}

async function persistItemSizeBytes(
  itemId,
  leaseGeneration,
  sizeBytes
) {
  const result = await pool.query(
    `
    UPDATE google_drive_account_migration_items
    SET size_bytes = $1, updated_at = NOW()
    WHERE id = $2 AND lease_generation = $3
    `,
    [String(sizeBytes), itemId, leaseGeneration]
  );
  assertFencedUpdate(result, itemId);
}

export async function persistSourceDeleteOutcome(
  itemId,
  leaseGeneration,
  sourceDeleteStatus,
  sourceDeleteError
) {
  const result = await pool.query(
    `
    UPDATE google_drive_account_migration_items
    SET
      source_delete_status = $1,
      source_delete_error = $2,
      updated_at = NOW()
    WHERE id = $3 AND lease_generation = $4
    `,
    [
      sourceDeleteStatus,
      sourceDeleteError,
      itemId,
      leaseGeneration,
    ]
  );
  assertFencedUpdate(result, itemId);
}

async function requeueItemWhenNoCapacity(
  itemId,
  leaseGeneration,
  errorMessage
) {
  const result = await pool.query(
    `
    UPDATE google_drive_account_migration_items
    SET
      status = 'pending',
      started_at = NULL,
      finished_at = NULL,
      bytes_transferred = 0,
      transfer_phase = 'pending',
      error_message = $1,
      updated_at = NOW()
    WHERE id = $2 AND lease_generation = $3
    `,
    [errorMessage, itemId, leaseGeneration]
  );
  assertFencedUpdate(result, itemId);
}

async function findExistingTargetFile(
  targetDrive,
  migrationItemId
) {
  const response = await targetDrive.files.list({
    q:
      "'me' in owners and " +
      "trashed = false and " +
      `appProperties has { key='college_noticeboard_migration_item' ` +
      `and value='${migrationItemId}' }`,
    fields:
      "files(id,name,size,mimeType,appProperties,trashed)",
    pageSize: 100,
  });

  const files =
    response.data.files ?? [];

  if (files.length > 1) {
    throw new Error(
      `Multiple target files found for migration item ${migrationItemId}; refusing to create another copy`
    );
  }

  return files[0] ?? null;
}

async function findExistingTargetFileEventually(
  targetDrive,
  migrationItemId,
  {
    attempts = 8,
    initialDelayMs = 500,
    maxDelayMs = 5000,
  } = {}
) {
  let delayMs = initialDelayMs;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const existing = await findExistingTargetFile(
      targetDrive,
      migrationItemId
    );

    if (existing?.id) {
      return existing;
    }

    if (attempt < attempts) {
      await sleep(delayMs);
      delayMs = Math.min(maxDelayMs, delayMs * 2);
    }
  }

  return null;
}

async function requeueItemAfterAmbiguousUpload(
  itemId,
  leaseGeneration,
  errorMessage,
  delayMs = 5000
) {
  const result = await pool.query(
    `
    UPDATE google_drive_account_migration_items
    SET
      status = 'pending',
      reserved_bytes = 0,
      target_recovery_required = TRUE,
      error_message = $1,
      started_at = NULL,
      finished_at = NULL,
      transfer_phase = 'verifying',
      next_retry_at = NOW() + ($3 * INTERVAL '1 millisecond'),
      updated_at = NOW()
    WHERE id = $2 AND lease_generation = $4
    `,
    [errorMessage, itemId, delayMs, leaseGeneration]
  );
  assertFencedUpdate(result, itemId);
}

const RECONCILIATION_DEADLINE_MS = 10 * 60 * 1000;

export async function markItemReconciling(
  itemId,
  leaseGeneration,
  errorMessage,
  deadlineMs = RECONCILIATION_DEADLINE_MS
) {
  const result = await pool.query(
    `
    UPDATE google_drive_account_migration_items
    SET
      status = 'reconciling',
      target_recovery_required = TRUE,
      reconciliation_deadline = NOW() + ($1 * INTERVAL '1 millisecond'),
      error_message = $2,
      transfer_phase = 'reconciling',
      next_retry_at = NOW() + INTERVAL '30 seconds',
      updated_at = NOW()
    WHERE id = $3 AND lease_generation = $4
    `,
    [deadlineMs, errorMessage, itemId, leaseGeneration]
  );
  assertFencedUpdate(result, itemId);
}

export async function markItemReconciliationExpired(
  itemId,
  leaseGeneration,
  errorMessage = "Reconciliation deadline reached; manual intervention required"
) {
  const result = await pool.query(
    `
    UPDATE google_drive_account_migration_items
    SET
      status = 'reconciliation_expired',
      transfer_phase = 'reconciliation_expired',
      target_recovery_required = TRUE,
      error_message = $1,
      next_retry_at = NULL,
      updated_at = NOW()
    WHERE id = $2 AND lease_generation = $3
    `,
    [errorMessage, itemId, leaseGeneration]
  );
  assertFencedUpdate(result, itemId);
}

async function reconcileTargetIfNeeded(
  item,
  migration,
  sourceMetadata,
  sourceAccount,
  targetAccount,
  targetDrive,
  abortController,
  workerNumber = null
) {
  if (
    !item.target_recovery_required &&
    item.status !== "reconciling"
  ) {
    return { kind: "skip" };
  }

  const currentTime = Date.now();
  const deadline = item.reconciliation_deadline
    ? new Date(item.reconciliation_deadline).getTime()
    : null;

  if (deadline !== null && currentTime >= deadline) {
    const message = `Reconciliation deadline reached for ${item.id}; manual intervention required`;

    await markItemReconciliationExpired(
      item.id,
      item.lease_generation,
      message
    );

    return {
      kind: "expired",
      itemId: item.id,
      sourceFileId: item.source_file_id,
      workerNumber,
      reason: message,
    };
  }

  try {
    const existingTarget = await findExistingTargetFile(
      targetDrive,
      item.id
    );

    if (existingTarget?.id) {
      const targetMetadata = await getTargetFileById(
        targetDrive,
        existingTarget.id,
        item.id,
        abortController
      );

      if (!targetMetadata?.id) {
        throw new Error(
          `Target ${existingTarget.id} could not be validated for migration item ${item.id}`
        );
      }

      if (
        sourceMetadata.size != null &&
        targetMetadata.size != null &&
        String(sourceMetadata.size) !== String(targetMetadata.size)
      ) {
        throw new Error(
          `Target size mismatch during reconciliation: source=${sourceMetadata.size}, target=${targetMetadata.size}`
        );
      }

      if (
        sourceMetadata.md5Checksum &&
        targetMetadata.md5Checksum &&
        sourceMetadata.md5Checksum !== targetMetadata.md5Checksum
      ) {
        throw new Error(
          `Target checksum mismatch during reconciliation: source=${sourceMetadata.md5Checksum}, target=${targetMetadata.md5Checksum}`
        );
      }

      await persistTargetFileId(
        item.id,
        item.lease_generation,
        targetMetadata.id
      );

      await persistRecoveredTargetProgress(
        item.id,
        item.lease_generation,
        sourceMetadata.size ?? 0,
        { clearRecoveryRequired: true }
      );

      return {
        kind: "continue",
        targetFileId: targetMetadata.id,
        targetAccount,
        targetDrive,
      };
    }

    const message = `Target upload outcome is uncertain for migration item ${item.id}; awaiting Drive reconciliation`;
    await markItemReconciling(
      item.id,
      item.lease_generation,
      message,
      RECONCILIATION_DEADLINE_MS
    );

    return {
      kind: "reconciling",
      itemId: item.id,
      sourceFileId: item.source_file_id,
      workerNumber,
      reason: message,
    };
  } catch (error) {
    if (error instanceof Error && /multiple target files/i.test(error.message)) {
      const message = `Ambiguous target recovery for migration item ${item.id}; leaving item unresolved`;
      await markItemReconciling(
        item.id,
        item.lease_generation,
        message,
        RECONCILIATION_DEADLINE_MS
      );

      return {
        kind: "reconciling",
        itemId: item.id,
        sourceFileId: item.source_file_id,
        workerNumber,
        reason: message,
      };
    }

    if (isFencedWorkerError(error) || isAbortError(error)) {
      throw error;
    }

    const message = `Target reconciliation failed for ${item.id}: ${error instanceof Error ? error.message : String(error)}`;
    await markItemReconciling(
      item.id,
      item.lease_generation,
      message,
      RECONCILIATION_DEADLINE_MS
    );

    return {
      kind: "reconciling",
      itemId: item.id,
      sourceFileId: item.source_file_id,
      workerNumber,
      reason: message,
    };
  }
}

export async function retryFailedSourceDeletion(
  itemId
) {
  const result = await pool.query(
    `
    SELECT
      i.id,
      i.lease_generation,
      i.source_file_id,
      i.target_file_id,
      i.target_account_id,
      i.source_delete_status,
      m.id AS migration_id,
      m.source_account_id,
      a.email AS source_email,
      a.status AS source_account_status,
      a.id AS source_account_id,
      a.client_id_encrypted,
      a.client_secret_encrypted,
      a.access_token_encrypted,
      a.refresh_token_encrypted,
      a.token_expires_at,
      a.redirect_uri,
      ta.email AS target_email,
      ta.status AS target_account_status,
      ta.client_id_encrypted AS target_client_id_encrypted,
      ta.client_secret_encrypted AS target_client_secret_encrypted,
      ta.access_token_encrypted AS target_access_token_encrypted,
      ta.refresh_token_encrypted AS target_refresh_token_encrypted,
      ta.token_expires_at AS target_token_expires_at,
      ta.redirect_uri AS target_redirect_uri
    FROM google_drive_account_migration_items i
    JOIN google_drive_account_migrations m
      ON m.id = i.migration_id
    JOIN google_drive_accounts a
      ON a.id = m.source_account_id
    LEFT JOIN google_drive_accounts ta
      ON ta.id = i.target_account_id
    WHERE i.id = $1
      AND i.status = 'completed'
      AND i.source_delete_status IN ('pending', 'failed')
    LIMIT 1
  `,
    [itemId]
  );

  const item = result.rows[0];

  if (!item) {
    return {
      status: "skipped",
      itemId,
    };
  }

  if (
    item.source_account_status !==
    "connected"
  ) {
    return {
      status: "waiting",
      itemId,
      reason:
        "Source Google Drive account is not connected",
    };
  }

  const sourceAccount = {
    connected_account_id:
      item.source_account_id,
    email: item.source_email,
    client_id_encrypted:
      item.client_id_encrypted,
    client_secret_encrypted:
      item.client_secret_encrypted,
    access_token_encrypted:
      item.access_token_encrypted,
    refresh_token_encrypted:
      item.refresh_token_encrypted,
    token_expires_at:
      item.token_expires_at,
    redirect_uri:
      item.redirect_uri,
    status:
      item.source_account_status,
  };

  const sourceDrive =
    await getGoogleDriveClientForAccount(
      sourceAccount
    );

  const abortController = getItemAbortController(item.id);

  if (
    !item.target_file_id ||
    !item.target_account_id ||
    item.target_account_id === item.source_account_id
  ) {
    return {
      status: "blocked",
      itemId: item.id,
      reason:
        "Target file/account is missing or invalid; source deletion refused",
    };
  }

  if (
    item.target_account_status !== "connected"
  ) {
    return {
      status: "waiting",
      itemId: item.id,
      reason:
        "Target Google Drive account is not connected",
    };
  }

  const targetAccount = {
    connected_account_id: item.target_account_id,
    email: item.target_email,
    client_id_encrypted:
      item.target_client_id_encrypted,
    client_secret_encrypted:
      item.target_client_secret_encrypted,
    access_token_encrypted:
      item.target_access_token_encrypted,
    refresh_token_encrypted:
      item.target_refresh_token_encrypted,
    token_expires_at:
      item.target_token_expires_at,
    redirect_uri:
      item.target_redirect_uri,
    status:
      item.target_account_status,
  };

  const targetDrive =
    await getGoogleDriveClientForAccount(
      targetAccount
    );

  try {
    const targetResponse =
      await targetDrive.files.get({
        fileId: item.target_file_id,
        fields:
          "id,name,size,mimeType,md5Checksum,appProperties,trashed",
      }, {
        signal: abortController?.signal,
      });

    const targetFile = targetResponse.data;

    if (targetFile?.trashed) {
      return {
        status: "blocked",
        itemId: item.id,
        reason:
          "Target file is trashed; source deletion refused",
      };
    }

    const migrationMarker =
      targetFile?.appProperties
        ?.college_noticeboard_migration_item;

    if (migrationMarker !== item.id) {
      return {
        status: "blocked",
        itemId: item.id,
        reason:
          "Target file does not belong to this migration item; source deletion refused",
      };
    }

    const mappingCheck = await pool.query(
      `
        SELECT 1
        FROM resources
        WHERE storage_key = $1
          AND storage_provider = 'google_drive'
          AND storage_status = 'synced'
          AND EXISTS (
            SELECT 1
            FROM google_drive_account_migration_items mi
            WHERE mi.id = $2
              AND mi.target_file_id = resources.storage_key
              AND mi.source_file_id = $3
          )
        LIMIT 1
      `,
      [
        item.target_file_id,
        item.id,
        item.source_file_id,
      ]
    );

    if (mappingCheck.rowCount !== 1) {
      return {
        status: "blocked",
        itemId: item.id,
        reason:
          "Application mapping for this migration item is missing; source deletion refused",
      };
    }
  } catch (error) {
    const status = getGoogleErrorStatus(error);

    if (status === 404) {
      await pool.query(
        `
        UPDATE google_drive_account_migration_items
        SET
          source_delete_status = 'blocked_target_missing',
          source_delete_error = $1,
          updated_at = NOW()
        WHERE id = $2
          AND source_delete_status IN ('pending', 'failed')
        `,
        [
          "Target file no longer exists; source deletion refused",
          item.id,
        ]
      );

      return {
        status: "blocked_target_missing",
        itemId: item.id,
        reason:
          "Target file no longer exists; source deletion refused",
      };
    }

    throw error;
  }

  /*
   * Cleanup is only permitted for an item that is already completed.
   * The target mapping was committed before this function can be reached.
   * Never use this reconciliation path to delete a source for an item that
   * has not completed its application-side migration.
   */
  if (item.source_delete_status !== 'pending' &&
    item.source_delete_status !== 'failed') {
    return {
      status: 'skipped',
      itemId: item.id,
    };
  }

  try {
    await sourceDrive.files.delete({
      fileId: item.source_file_id,
    }, {
      signal: abortController?.signal,
    });
  } catch (error) {
    const status =
      getGoogleErrorStatus(error);

    /*
     * A 404 means the source object is already gone.
     * That is the desired final state, so treat it as
     * successful cleanup.
     */
    if (status !== 404) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      /*
       * Scheduler-owned cleanup: the item is already completed and this
       * path does not hold the worker lease. Do not fence by lease_generation.
       */
      await pool.query(
        `
        UPDATE google_drive_account_migration_items
        SET
          source_delete_status = 'failed',
          source_delete_error = $1,
          cleanup_attempt_count = cleanup_attempt_count + 1,
          cleanup_next_attempt_at = NOW() + (
            LEAST(3600, POWER(2, LEAST(cleanup_attempt_count + 1, 8)) * 30)
            * INTERVAL '1 second'
          ),
          updated_at = NOW()
        WHERE id = $2
        `,
        [
          message,
          item.id,
        ]
      );

      return {
        status: "failed",
        itemId: item.id,
        error: message,
      };
    }
  }

  /*
   * Scheduler-owned cleanup: completed items are retried without a worker
   * lease. Do not fence by lease_generation.
   */
  await pool.query(
    `
    UPDATE google_drive_account_migration_items
    SET
      source_delete_status = 'deleted',
      source_delete_error = NULL,
      cleanup_attempt_count = 0,
      cleanup_next_attempt_at = NULL,
      updated_at = NOW()
    WHERE id = $1
      AND source_delete_status IN ('pending', 'failed')
    `,
    [item.id]
  );

  console.log(
    `[MIGRATION ${item.migration_id}] ` +
    `Source cleanup completed for ${item.source_file_id}`
  );

  return {
    status: "deleted",
    itemId: item.id,
    sourceFileId: item.source_file_id,
  };
}

const PROGRESS_WRITE_INTERVAL_MS = 2500;

/*
 * Progress is written at a bounded rate so a large file does not
 * generate one PostgreSQL UPDATE per stream chunk.
 */
export async function updateItemProgress(
  itemId,
  leaseGeneration,
  bytesTransferred,
  transferPhase
) {
  const result = await pool.query(
    `
    UPDATE google_drive_account_migration_items
    SET
      speed_bytes_per_second = CASE
        WHEN updated_at IS NOT NULL
          AND EXTRACT(EPOCH FROM (NOW() - updated_at)) > 0
          AND $1::numeric >= bytes_transferred
        THEN GREATEST(
          0,
          ($1::numeric - bytes_transferred)
          / EXTRACT(EPOCH FROM (NOW() - updated_at))
        )
        ELSE speed_bytes_per_second
      END,
      bytes_transferred = $1,
      transfer_phase = $2,
      updated_at = NOW()
    WHERE id = $3 AND lease_generation = $4
    `,
    [
      String(bytesTransferred),
      transferPhase,
      itemId,
      leaseGeneration
    ]
  );
  assertFencedUpdate(result, itemId);
}

export function createTrackedUploadStream(
  sourceStream,
  {
    itemId,
    leaseGeneration,
    startedAt,
    sizeBytes,
    abortController = null,
  }
) {
  if (leaseGeneration == null) {
    throw new Error(
      `createTrackedUploadStream: leaseGeneration is required for item ${itemId}`
    );
  }

  let bytesTransferred = 0n;
  let lastWriteAt = 0;
  let writeChain = Promise.resolve();
  let fenceError = null;
  let tracker;

  function destroyStreamWithAbort(reason = "Transfer aborted") {
    if (!tracker || tracker.destroyed) {
      return;
    }

    const abortError = new Error(reason);
    abortError.name = "AbortError";
    tracker.destroy(abortError);
  }

  function rememberFenceError(error) {
    if (!isFencedWorkerError(error)) {
      return false;
    }

    fenceError = error;

    if (tracker && !tracker.destroyed) {
      tracker.destroy(error);
    }

    return true;
  }

  function queueProgressWrite(
    force = false,
    phase = "uploading"
  ) {
    if (fenceError) {
      return writeChain;
    }

    const now = Date.now();

    if (
      !force &&
      now - lastWriteAt < PROGRESS_WRITE_INTERVAL_MS
    ) {
      return;
    }

    lastWriteAt = now;
    const snapshot = bytesTransferred;

    writeChain = writeChain
      .then(() => {
        if (fenceError) {
          throw fenceError;
        }

        return updateItemProgress(
          itemId,
          leaseGeneration,
          snapshot,
          phase
        );
      })
      .catch((error) => {
        if (rememberFenceError(error)) {
          return;
        }

        console.error(
          `[MIGRATION] Progress update failed for ${itemId}:`,
          error instanceof Error
            ? error.message
            : error
        );
      });
  }

  tracker = new Transform({
    readableHighWaterMark: 1024 * 1024,
    writableHighWaterMark: 1024 * 1024,

    transform(chunk, encoding, callback) {
      if (fenceError) {
        callback(fenceError);
        return;
      }

      try {
        bytesTransferred += BigInt(chunk.length);
        queueProgressWrite(false, "uploading");
        callback(null, chunk);
      } catch (error) {
        callback(error);
      }
    },

    flush(callback) {
      if (fenceError) {
        callback(fenceError);
        return;
      }

      /*
       * Do not force a final PostgreSQL progress write here.
       * The caller immediately advances the item to the next
       * fenced transfer phase after the upload completes.
       */
      callback();
    },
  });

  tracker.on("error", (error) => {
    if (isAbortError(error) || isFencedWorkerError(error)) {
      return;
    }

    console.error(
      `[MIGRATION] Upload stream error for ${itemId}:`,
      error instanceof Error ? error.message : error
    );
  });

  if (abortController) {
    const abortStream = () => {
      destroyStreamWithAbort(`Transfer aborted for item ${itemId}`);
    };

    if (abortController.signal.aborted) {
      abortStream();
    } else {
      abortController.signal.addEventListener("abort", abortStream, { once: true });
    }
  }

  sourceStream.on("error", (error) => {
    if (isAbortError(error)) {
      return;
    }
    tracker.destroy(error);
  });

  tracker.transferStartedAt = Date.now();
  tracker.sourceStreamEndedAt = null;

  sourceStream.once("end", () => {
    tracker.sourceStreamEndedAt = Date.now();
  });

  sourceStream.pipe(tracker);

  tracker.getFenceError = () => fenceError;

  tracker.getProgressState = async () => {
    /*
     * Wait for progress writes already queued during the transfer,
     * but do not enqueue another redundant final UPDATE.
     */
    await writeChain;

    if (fenceError) {
      throw fenceError;
    }

    const elapsedSeconds = Math.max(
      0.001,
      (Date.now() - startedAt.getTime()) / 1000
    );

    const speed =
      Number(bytesTransferred) / elapsedSeconds;

    const remaining =
      BigInt(sizeBytes) > bytesTransferred
        ? BigInt(sizeBytes) - bytesTransferred
        : 0n;

    const eta =
      speed > 0
        ? Number(remaining) / speed
        : null;

    return {
      bytesTransferred,
      speedBytesPerSecond: speed,
      etaSeconds: eta,
      elapsedSeconds,
      transferElapsedMs:
        Date.now() - tracker.transferStartedAt,
      sourceStreamElapsedMs:
        tracker.sourceStreamEndedAt == null
          ? null
          : tracker.sourceStreamEndedAt -
            tracker.transferStartedAt,
    };
  };

  return tracker;
}

async function isMigrationCancelRequested(migrationId) {
  const result = await pool.query(
    `SELECT cancel_requested, status FROM google_drive_account_migrations WHERE id = $1 LIMIT 1`,
    [migrationId]
  );
  return {
    requested: Boolean(result.rows[0]?.cancel_requested),
    status: result.rows[0]?.status ?? null,
  };
}

export async function finalizeCancellationIfIdle(migrationId) {
  const result = await pool.query(
    `
    UPDATE google_drive_account_migrations m
    SET status = 'cancelled', finished_at = COALESCE(finished_at, NOW()), updated_at = NOW()
    WHERE m.id = $1
      AND m.cancel_requested = TRUE
      AND m.status IN ('pending', 'running', 'waiting_for_storage')
      AND NOT EXISTS (
        SELECT 1 FROM google_drive_account_migration_items i
        WHERE i.migration_id = m.id AND i.status = 'running'
      )
    RETURNING id, status
    `, [migrationId]
  );
  return result.rowCount > 0;
}

export async function migrateOneItem(
  migrationId,
  workerNumber = null,
  workerCount = null
) {
  const workerLabel = workerNumber
    ? `[WORKER ${workerNumber}${workerCount ? `/${workerCount}` : ""}]`
    : "[WORKER direct]";
  const logPrefix = `[MIGRATION ${migrationId}] ${workerLabel}`;
  const log = (...args) => console.log(logPrefix, ...args);
  const warn = (...args) => console.warn(logPrefix, ...args);
  const errorLog = (...args) => console.error(logPrefix, ...args);
  const migration =
    await getMigration(migrationId);

  if (!migration) {
    throw new Error("Migration not found");
  }

  if (
    migration.status !== "pending" &&
    migration.status !== "running" &&
    migration.status !== "waiting_for_storage"
  ) {
    return {
      status: migration.status,
      message: "Migration is not runnable",
    };
  }

  if (migration.cancel_requested) {
    await finalizeCancellationIfIdle(migrationId);
    const latest = await getMigration(migrationId);
    return {
      status: latest?.status ?? 'cancelled',
      message: 'Migration cancellation requested',
    };
  }

  const sourceAccount =
    await getAccount(
      migration.source_account_id
    );

  if (!sourceAccount) {
    throw new Error(
      "Source Google Drive account not found"
    );
  }

  if (sourceAccount.status !== "connected") {
    throw new Error(
      "Source Google Drive account is not connected"
    );
  }

  if (
    migration.status === "pending" ||
    migration.status ===
    "waiting_for_storage"
  ) {
    await pool.query(
      `
  UPDATE google_drive_account_migrations
  SET
    status = 'running',
    started_at = COALESCE(started_at, NOW()),
    updated_at = NOW()
  WHERE id = $1
    AND status IN (
      'pending',
      'waiting_for_storage'
    )
  `,
      [migrationId]
    );
  }

  if ((await isMigrationCancelRequested(migrationId)).requested) {
    await finalizeCancellationIfIdle(migrationId);
    const latest = await getMigration(migrationId);
    return { status: latest?.status ?? 'cancelled', message: 'Migration cancellation requested' };
  }

  const item =
    await claimNextItem(migrationId);

  if (!item) {
    await finishMigrationIfComplete(
      migrationId
    );

    const latest =
      await getMigration(migrationId);

    return {
      status: latest?.status,
      message: "No pending migration items",
    };
  }

  const abortController = getItemAbortController(item.id);

  const ensureHeartbeatStillValid = () => {
    const heartbeatError = itemLeaseHeartbeatErrors.get(item.id);
    if (heartbeatError) {
      abortItemTransfer(item.id);
      throw heartbeatError;
    }
  };

  const abortIfCancelled = async () => {
    const { requested } = await isMigrationCancelRequested(migrationId);
    if (!requested) {
      return;
    }

    abortItemTransfer(item.id);
    const error = new Error("Migration cancellation requested");
    error.name = "AbortError";
    throw error;
  };

  startItemLeaseHeartbeat(item.id, item.lease_generation, abortController);

  await updateCurrentFile(
    migrationId,
    item.source_file_id
  );

  ensureHeartbeatStillValid();
  await abortIfCancelled();

  let targetFileId = null;
  let createdTargetFile = false;
  let mappingCommitted = false;
  let targetAccount = null;
  let targetDrive = null;
  let uploadResponse = null;
  let trackedUploadStream = null;

  try {
    ensureHeartbeatStillValid();
    await abortIfCancelled();

    const sourceDrive =
      await getGoogleDriveClientForAccount(
        sourceAccount
      );

    ensureHeartbeatStillValid();
    await abortIfCancelled();

    const sourceMetadataResponse =
      await sourceDrive.files.get({
        fileId: item.source_file_id,
        fields: "id,name,size,mimeType,md5Checksum",
      }, {
        signal: abortController.signal,
      });

    const sourceMetadata =
      sourceMetadataResponse.data;

    if (!sourceMetadata.id) {
      throw new Error(
        "Source file metadata did not contain an ID"
      );
    }

    const requiredBytes = toBigInt(
      sourceMetadata.size ?? 0,
      "sourceMetadata.size"
    );

    /*
     * A persisted target ID without a persisted target account is
     * ambiguous. Refuse to guess rather than risk another upload.
     */
    if (
      item.target_file_id &&
      (!item.target_account_id ||
        item.target_account_id ===
        migration.source_account_id)
    ) {
      throw new Error(
        "Migration item has a target file but no valid target account; refusing to create a duplicate"
      );
    }

    /*
     * Crash-safe idempotency:
     *
     * The Drive upload can succeed before PostgreSQL records that
     * the item is complete. On restart, always prefer a previously
     * persisted target_file_id and then the migration-item marker on
     * the already-assigned target account. Do this BEFORE quota
     * selection so a target that is now low on free space is not
     * replaced by a second target copy.
     */
    if (
      item.target_account_id &&
      item.target_account_id !==
      migration.source_account_id
    ) {
      const assignedAccount =
        await getAccount(
          item.target_account_id
        );

      if (
        assignedAccount &&
        assignedAccount.status === "connected"
      ) {
        log(
          `Recovery: loading Drive client for assigned target account ${assignedAccount.email}`
        );

        const assignedDrive =
          await getGoogleDriveClientForAccount(
            assignedAccount
          );

        log(
          `Recovery: Drive client ready for ${assignedAccount.email}`
        );

        targetAccount =
          assignedAccount;

        targetDrive =
          assignedDrive;

        if (item.target_file_id) {
          log(
            `Recovery: verifying persisted target ${item.target_file_id}`
          );

          const persistedTarget =
            await getTargetFileById(
              assignedDrive,
              item.target_file_id,
              item.id
            );

          log(
            `Recovery: persisted target lookup finished`
          );

          if (persistedTarget?.id) {
            targetFileId =
              persistedTarget.id;

            await persistRecoveredTargetProgress(
              item.id,
              item.lease_generation,
              sourceMetadata.size ?? 0,
              { clearRecoveryRequired: false }
            );
          }
        }

        if (!targetFileId) {
          log(
            `Recovery: searching Drive for uploaded target using migration item ${item.id}`
          );

          try {
            const existingAssignedTarget =
              await findExistingTargetFile(
                assignedDrive,
                item.id
              );

            log(
              `Recovery: existing-target search finished` +
              ` (${existingAssignedTarget?.id ?? "not found"})`
            );

            if (existingAssignedTarget?.id) {
              targetFileId =
                existingAssignedTarget.id;

              await persistTargetFileId(
                item.id,
                item.lease_generation,
                targetFileId
              );

              await persistRecoveredTargetProgress(
                item.id,
                item.lease_generation,
                sourceMetadata.size ?? 0,
                { clearRecoveryRequired: true }
              );
            }
          } catch (recoverySearchError) {
            if (
              recoverySearchError instanceof Error &&
              /multiple target files found/i.test(recoverySearchError.message)
            ) {
              const message = `Ambiguous target recovery for migration item ${item.id}; leaving the item unresolved`;
              await markItemReconciling(
                item.id,
                item.lease_generation,
                message,
                RECONCILIATION_DEADLINE_MS
              );

              return {
                status: "reconciling",
                itemId: item.id,
                sourceFileId: item.source_file_id,
                workerNumber,
                reason: message,
              };
            }

            throw recoverySearchError;
          }
        }
      } else if (item.target_file_id) {
        /*
         * We have a durable target ID but cannot currently access
         * its account. Never upload to another account blindly.
         */
        throw new Error(
          "Previously uploaded target file exists, but its assigned Google Drive account is unavailable"
        );
      }
    }

    if (item.target_recovery_required && !targetFileId) {
      const recoveryAccountId =
        item.target_account_id &&
        item.target_account_id !== migration.source_account_id
          ? item.target_account_id
          : migration.target_account_id &&
            migration.target_account_id !== migration.source_account_id
            ? migration.target_account_id
            : null;

      if (recoveryAccountId) {
        const recoveryAccount = await getAccount(recoveryAccountId);
        if (recoveryAccount?.status === "connected") {
          targetAccount = recoveryAccount;
          targetDrive = await getGoogleDriveClientForAccount(recoveryAccount);
        }
      }

      if (targetDrive) {
        const reconcileResult = await reconcileTargetIfNeeded(
          item,
          migration,
          sourceMetadata,
          sourceAccount,
          targetAccount,
          targetDrive,
          abortController,
          workerNumber
        );

        if (reconcileResult.kind === "expired") {
          return reconcileResult;
        }

        if (reconcileResult.kind === "reconciling") {
          return reconcileResult;
        }

        if (reconcileResult.kind === "continue") {
          targetFileId = reconcileResult.targetFileId;
          targetAccount = reconcileResult.targetAccount;
          targetDrive = reconcileResult.targetDrive;
        }
      } else {
        const message = `Target upload outcome is uncertain for migration item ${item.id}; awaiting Drive reconciliation`;
        await markItemReconciling(
          item.id,
          item.lease_generation,
          message,
          RECONCILIATION_DEADLINE_MS
        );

        return {
          status: "reconciling",
          itemId: item.id,
          sourceFileId: item.source_file_id,
          workerNumber,
          reason: message,
        };
      }
    }

    let selectedTarget = null;

    if (!targetFileId) {
      selectedTarget =
        await chooseTargetAccount(
          migration,
          item,
          requiredBytes
        );
    }

    if (!targetFileId && !selectedTarget) {
      ensureHeartbeatStillValid();

      await requeueItemWhenNoCapacity(
        item.id,
        item.lease_generation,
        "Waiting for an available Google Drive account with enough storage"
      );

      /*
       * With multiple file workers, another item in this migration may still
       * be actively using the available target accounts. Do not put the
       * entire migration into waiting_for_storage while sibling workers are
       * still making progress. Only transition the migration itself when
       * there are no other running items.
       */
      const runningItemsResult = await pool.query(
        `
        SELECT 1
        FROM google_drive_account_migration_items
        WHERE migration_id = $1
          AND status = 'running'
        LIMIT 1
        `,
        [migrationId]
      );

      if (runningItemsResult.rowCount === 0) {
        await pool.query(
          `
    UPDATE google_drive_account_migrations
    SET
      status = 'waiting_for_storage',
      current_file_id = $2,
      updated_at = NOW()
    WHERE id = $1
      AND status = 'running'
    `,
          [migrationId, item.source_file_id]
        );

        log(
          `Waiting for storage for ${sourceMetadata.name}`
        );

        return {
          status: "waiting_for_storage",
          itemId: item.id,
          sourceFileId: item.source_file_id,
          name: sourceMetadata.name,
          workerNumber,
        };
      }

      return {
        status: "deferred_storage",
        itemId: item.id,
        sourceFileId: item.source_file_id,
        name: sourceMetadata.name,
        workerNumber,
      };
    }

    if (selectedTarget) {
      targetAccount =
        selectedTarget.account;

      targetDrive =
        selectedTarget.drive;
    }
    if (!sourceMetadata.id) {
      throw new Error(
        "Source file metadata did not contain an ID"
      );
    }

    if (
      String(sourceMetadata.size ?? 0) !==
      String(item.size_bytes ?? 0)
    ) {
      await persistItemSizeBytes(
        item.id,
        item.lease_generation,
        sourceMetadata.size ?? 0
      );
    }

    if (!targetFileId) {
      ensureHeartbeatStillValid();

      /*
       * Clean first attempts upload immediately. Recovered attempts first
       * reconcile by migration marker so a previous successful upload is
       * reused instead of duplicated. If recovery finds nothing, continue
       * with a fresh upload.
       */
      if (item.target_recovery_required) {
        log(
          `Checking for existing target copy of ${sourceMetadata.name}`
        );

        try {
          const existingTarget =
            await findExistingTargetFile(
              targetDrive,
              item.id
            );

          if (existingTarget?.id) {
            log(
              `Found existing target ${existingTarget.id}; reusing it`
            );

            targetFileId = existingTarget.id;

            await persistTargetFileId(
              item.id,
              item.lease_generation,
              targetFileId
            );

            await persistRecoveredTargetProgress(
              item.id,
              item.lease_generation,
              sourceMetadata.size ?? 0,
              { clearRecoveryRequired: true }
            );
          }
        } catch (recoverySearchError) {
          if (
            recoverySearchError instanceof Error &&
            /multiple target files found/i.test(recoverySearchError.message)
          ) {
            const message = `Ambiguous target recovery for migration item ${item.id}; leaving the item unresolved`;
            await markItemReconciling(
              item.id,
              item.lease_generation,
              message,
              RECONCILIATION_DEADLINE_MS
            );

            return {
              status: "reconciling",
              itemId: item.id,
              sourceFileId: item.source_file_id,
              workerNumber,
              reason: message,
            };
          }

          throw recoverySearchError;
        }
      }

      if (!targetFileId) {
        const transferStartedAt = item.started_at
          ? new Date(item.started_at)
          : new Date();

        ensureHeartbeatStillValid();

        log(
          `Downloading ${sourceMetadata.name} ` +
          `from ${sourceAccount.email}`
        );

        const downloadResponse =
          await sourceDrive.files.get(
            {
              fileId: item.source_file_id,
              alt: "media",
            },
            {
              responseType: "stream",
              signal: abortController.signal,
            }
          );
        ensureHeartbeatStillValid();

        log(
          `Uploading ${sourceMetadata.name} ` +
          `to ${targetAccount.email}`
        );

        trackedUploadStream =
          createTrackedUploadStream(
            downloadResponse.data,
            {
              itemId: item.id,
              leaseGeneration: item.lease_generation,
              startedAt: transferStartedAt,
              sizeBytes: toBigInt(
                sourceMetadata.size ?? 0,
                "sourceMetadata.size"
              ),
              abortController,
            }
          );

        const uploadStartedAt = Date.now();

        try {
          uploadResponse =
            await targetDrive.files.create({
              requestBody: {
                name: sourceMetadata.name,
                mimeType:
                  sourceMetadata.mimeType ||
                  "application/octet-stream",
                appProperties: {
                  college_noticeboard_migration_item:
                    item.id,
                },
              },
              media: {
                mimeType:
                  sourceMetadata.mimeType ||
                  "application/octet-stream",
                body: trackedUploadStream,
              },
              fields:
                "id,name,size,mimeType,md5Checksum,appProperties",
            }, {
              signal: abortController.signal,
            });

          const uploadElapsedMs =
            Date.now() - uploadStartedAt;

          log(
            `Upload completed for ${sourceMetadata.name} ` +
            `in ${uploadElapsedMs}ms`
          );
        } catch (error) {
          if (isFencedWorkerError(error) || isAbortError(error)) {
            throw error;
          }

          const message = `Upload outcome is uncertain for ${item.id}: ${error instanceof Error ? error.message : String(error)}`;
          await markItemReconciling(
            item.id,
            item.lease_generation,
            message,
            RECONCILIATION_DEADLINE_MS
          );

          return {
            status: "reconciling",
            itemId: item.id,
            sourceFileId: item.source_file_id,
            targetFileId: null,
            workerNumber,
            reason: message,
          };
        }

        const transferState =
          await trackedUploadStream.getProgressState();

        const sourceElapsedMs =
          transferState.sourceStreamElapsedMs;

        log(
          `Transfer timing for ${sourceMetadata.name}: ` +
          `${transferState.bytesTransferred} bytes, ` +
          `source=${sourceElapsedMs == null ? "n/a" : `${(sourceElapsedMs / 1000).toFixed(2)}s`}, ` +
          `total=${(transferState.transferElapsedMs / 1000).toFixed(2)}s, ` +
          `rate=${(transferState.speedBytesPerSecond / 1024 / 1024).toFixed(2)} MB/s`
        );

        targetFileId =
          uploadResponse?.data?.id ?? null;

        if (!targetFileId) {
          /*
           * The Drive upload may have succeeded even if the response omitted
           * the ID. Never issue a second upload blindly; reconcile by the
           * unique migration-item marker first.
           */
          log(
            `Upload response did not include a file ID; reconciling by migration marker for ${item.id}`
          );

          const recoveredTarget =
            await findExistingTargetFileEventually(
              targetDrive,
              item.id
            );

          if (recoveredTarget?.id) {
            targetFileId = recoveredTarget.id;
            log(
              `Recovered target ${targetFileId} after missing upload response ID`
            );
          } else {
            const ambiguousUploadMessage =
              "Google Drive upload returned no file ID and the target could not yet be recovered by migration marker";

            await markItemReconciling(
              item.id,
              item.lease_generation,
              ambiguousUploadMessage,
              RECONCILIATION_DEADLINE_MS
            );

            log(
              "Ambiguous upload response; item remains in reconciliation instead of retrying the upload blindly"
            );

            return {
              status: "reconciling",
              itemId: item.id,
              sourceFileId: item.source_file_id,
              workerNumber,
              reason: ambiguousUploadMessage,
            };
          }
        }

        createdTargetFile = true;

        await persistTargetFileId(
          item.id,
          item.lease_generation,
          targetFileId
        );

        await updateItemProgress(
          item.id,
          item.lease_generation,
          toBigInt(sourceMetadata.size ?? 0, "sourceMetadata.size"),
          "verifying"
        );
      }
    }

    ensureHeartbeatStillValid();

    if (!targetFileId) {
      throw new Error(
        "Target Google Drive did not return a file ID"
      );
    }

    let targetMetadata = null;

    /*
     * A fresh upload response already contains the target metadata needed
     * for size/checksum validation. Reuse it when complete instead of
     * paying for another Drive GET. Recovered targets still use GET.
     */
    if (createdTargetFile && uploadResponse?.data?.id === targetFileId) {
      targetMetadata = uploadResponse.data;
    }

    if (!targetMetadata?.size && sourceMetadata.size != null) {
      const targetMetadataResponse =
        await targetDrive.files.get({
          fileId: targetFileId,
          fields: "id,name,size,mimeType,md5Checksum",
        }, {
          signal: abortController.signal,
        });

      targetMetadata =
        targetMetadataResponse.data;
    }

    if (
      sourceMetadata.size != null &&
      targetMetadata.size != null &&
      String(sourceMetadata.size) !==
      String(targetMetadata.size)
    ) {
      throw new Error(
        `Size mismatch: source=${sourceMetadata.size}, target=${targetMetadata.size}`
      );
    }

    if (
      sourceMetadata.md5Checksum &&
      targetMetadata.md5Checksum &&
      sourceMetadata.md5Checksum !== targetMetadata.md5Checksum
    ) {
      throw new Error(
        `Checksum mismatch: source=${sourceMetadata.md5Checksum}, target=${targetMetadata.md5Checksum}`
      );
    }

    /*
 * Switch the application's mapping only after
 * the target file has been uploaded and verified.
 *
 * The old source file is still untouched at this point.
 */
    ensureHeartbeatStillValid();

    await updateItemProgress(
      item.id,
      item.lease_generation,
      toBigInt(sourceMetadata.size ?? 0, "sourceMetadata.size"),
      "mapping"
    );

    const mappingClient = await pool.connect();

    try {
      await mappingClient.query("BEGIN");

      const sourceMappingResult = await mappingClient.query(
        `
        SELECT id
        FROM resources
        WHERE storage_key = $1
        LIMIT 2
        FOR UPDATE
        `,
        [item.source_file_id]
      );

      if (sourceMappingResult.rowCount > 1) {
        throw new Error(
          `Refusing to delete source: multiple resource mappings found for source ${item.source_file_id}`
        );
      }

      if (sourceMappingResult.rowCount === 1) {
        const resourceUpdateResult = await mappingClient.query(
          `
          UPDATE resources
          SET
            storage_provider = 'google_drive',
            storage_key = $1,
            storage_status = 'synced',
            storage_error = NULL
          WHERE id = $2
          `,
          [
            targetFileId,
            sourceMappingResult.rows[0].id,
          ]
        );

        if (resourceUpdateResult.rowCount !== 1) {
          throw new Error(
            `Refusing to delete source: expected exactly 1 resource mapping for source ${item.source_file_id}, updated ${resourceUpdateResult.rowCount}`
          );
        }
      } else {
        /*
         * Recovery case: a previous process may have committed the mapping
         * switch before crashing. In that case the source key no longer
         * exists, and the target mapping is already the committed state.
         * Verify it instead of treating the legitimate recovery state as a
         * new mapping failure.
         */
        const targetMappingResult = await mappingClient.query(
          `
          SELECT id
          FROM resources
          WHERE storage_key = $1
            AND storage_provider = 'google_drive'
            AND storage_status = 'synced'
          LIMIT 2
          FOR UPDATE
          `,
          [targetFileId]
        );

        if (targetMappingResult.rowCount !== 1) {
          throw new Error(
            `Refusing to delete source: existing committed target mapping for ${targetFileId} could not be verified`
          );
        }
      }

      await mappingClient.query(
        `
    DELETE FROM google_drive_file_accounts
    WHERE file_id = $1
      AND account_id = $2
    `,
        [
          item.source_file_id,
          sourceAccount.connected_account_id,
        ]
      );

      await mappingClient.query(
        `
    INSERT INTO google_drive_file_accounts (
      file_id,
      account_id
    )
    VALUES ($1, $2)
    ON CONFLICT (file_id)
    DO UPDATE SET
      account_id = EXCLUDED.account_id
    `,
        [
          targetFileId,
          targetAccount.connected_account_id,
        ]
      );

      const mappingVerificationResult =
        await mappingClient.query(
          `
      SELECT
        storage_provider,
        storage_key,
        storage_status
      FROM resources
      WHERE storage_key = $1
        AND storage_provider = 'google_drive'
        AND storage_status = 'synced'
      LIMIT 1
    `,
          [targetFileId]
        );

      if (mappingVerificationResult.rowCount !== 1) {
        throw new Error(
          `Refusing to delete source: committed resource mapping to target ${targetFileId} could not be verified`
        );
      }

      await mappingClient.query("COMMIT");
      mappingCommitted = true;
    } catch (error) {
      try {
        await mappingClient.query("ROLLBACK");
      } catch { }

      throw error;
    } finally {
      mappingClient.release();
    }

    /*
     * The application now points at the verified target.
     * Only now do we delete the old Drive object.
     */
    let sourceDeleteStatus = "pending";
    let sourceDeleteError = null;

    /*
     * Hard safety invariant: the source may only be deleted after the
     * application mapping transaction has committed successfully.
     */
    if (!mappingCommitted) {
      throw new Error(
        "Refusing to delete source before target mapping is committed"
      );
    }

    /*
     * Re-verify the target immediately before destructive source deletion.
     * This closes the window where a target could disappear after the first
     * verification but before the source DELETE. If the target is missing,
     * leave the source untouched and fail the item for manual/retry handling.
     */
    try {
      const finalTargetResponse = await targetDrive.files.get({
        fileId: targetFileId,
        fields: "id,name,size,mimeType,md5Checksum",
      }, {
        signal: abortController.signal,
      });
      const finalTarget = finalTargetResponse.data;
      if (
        sourceMetadata.size != null &&
        finalTarget.size != null &&
        String(sourceMetadata.size) !== String(finalTarget.size)
      ) {
        throw new Error(
          `Final target size mismatch before source deletion: source=${sourceMetadata.size}, target=${finalTarget.size}`
        );
      }
      if (
        sourceMetadata.md5Checksum &&
        finalTarget.md5Checksum &&
        sourceMetadata.md5Checksum !== finalTarget.md5Checksum
      ) {
        throw new Error(
          `Final target checksum mismatch before source deletion: source=${sourceMetadata.md5Checksum}, target=${finalTarget.md5Checksum}`
        );
      }
    } catch (targetVerificationError) {
      const targetStatus =
        getGoogleErrorStatus(targetVerificationError);

      if (targetStatus === 404) {
        await persistSourceDeleteOutcome(
          item.id,
          item.lease_generation,
          "blocked_target_missing",
          "Target file disappeared after mapping commit; source was not deleted"
        );

        throw new Error(
          "Target file disappeared after mapping commit; source was not deleted"
        );
      }

      throw targetVerificationError;
    }

    const finalMappingCheck = await pool.query(
      `
    SELECT
      storage_provider,
      storage_key,
      storage_status
    FROM resources
    WHERE storage_key = $1
      AND storage_provider = 'google_drive'
      AND storage_status = 'synced'
    LIMIT 1
  `,
      [targetFileId]
    );

    if (finalMappingCheck.rowCount !== 1) {
      await persistSourceDeleteOutcome(
        item.id,
        item.lease_generation,
        "blocked_target_missing",
        `Refusing to delete source: application mapping to target ${targetFileId} is no longer present`
      );

      throw new Error(
        `Refusing to delete source: application mapping to target ${targetFileId} is no longer present`
      );
    }

    ensureHeartbeatStillValid();

    await updateItemProgress(
      item.id,
      item.lease_generation,
      toBigInt(sourceMetadata.size ?? 0, "sourceMetadata.size"),
      "deleting_source"
    );

    try {
      await sourceDrive.files.delete({
    fileId: item.source_file_id,
  }, {
    signal: abortController.signal,
  });

  sourceDeleteStatus = "deleted";
} catch (deleteError) {
  sourceDeleteStatus = "failed";
  sourceDeleteError =
    deleteError instanceof Error
      ? deleteError.message
      : String(deleteError);

  errorLog(
    `Source deletion failed for ${item.source_file_id}:`,
    sourceDeleteError
  );
}

    await persistSourceDeleteOutcome(
      item.id,
      item.lease_generation,
      sourceDeleteStatus,
      sourceDeleteError
    );

    await markItemCompleted(
      item.id,
      item.lease_generation,
      targetFileId
    );

    clearRetryCount(item.id, item.lease_generation);

    await incrementCompleted(
      migrationId
    );

    await finishMigrationIfComplete(
      migrationId
    );

    await finalizeCancellationIfIdle(migrationId);

    log(
      `${sourceMetadata.name} migrated successfully`
    );

    return {
      status: "completed",
      itemId: item.id,
      sourceFileId: item.source_file_id,
      targetFileId,
      name: sourceMetadata.name,
      workerNumber,
    };
  } catch (error) {
    const heartbeatError = itemLeaseHeartbeatErrors.get(item.id);

    if (heartbeatError) {
      abortItemTransfer(item.id);
      throw heartbeatError;
    }

    if (isFencedWorkerError(error) || isAbortError(error)) {
      abortItemTransfer(item.id);
      throw error;
    }

    const message =
      error instanceof Error
        ? error.message
        : String(error);

    if (
      error instanceof TypeError &&
      /BigInt|Cannot mix/i.test(message) &&
      error.stack
    ) {
      errorLog(error.stack);
    }

    /*
     * Retry transient Google/network failures.
     *
     * These include:
     * - HTTP 429
     * - HTTP 5xx
     * - Google rate-limit/backend errors
     * - temporary network failures
     */
    const errorClass = classifyGoogleError(error);

    if (errorClass.type === "authorization_invalid") {
      const accountId =
        targetAccount?.connected_account_id ??
        sourceAccount?.connected_account_id ??
        null;

      if (accountId) {
        await markAccountAuthorizationInvalid(accountId, message);
      }

      const authMessage =
        `Google Drive authorization is invalid for account ${accountId ?? "unknown"}: ${message}`;

      await markItemFailed(
        item.id,
        item.lease_generation,
        authMessage
      );

      await incrementFailed(
        migrationId,
        authMessage
      );

      await finishMigrationIfComplete(
        migrationId
      );

      return {
        status: "failed",
        itemId: item.id,
        sourceFileId: item.source_file_id,
        reason: authMessage,
      };
    }

    if (errorClass.type === "storage") {
      await requeueItemAfterStorageWait(
        item.id,
        item.lease_generation,
        `Waiting for storage: ${message}`
      );

      await pool.query(
        `
        UPDATE google_drive_account_migrations
        SET
          status = 'waiting_for_storage',
          current_file_id = $2,
          updated_at = NOW()
        WHERE id = $1
          AND status = 'running'
        `,
        [migrationId, item.source_file_id]
      );

      warn(
        `Storage/quota failure for ${item.source_file_id}; waiting for capacity: ${message}`
      );

      return {
        status: "waiting_for_storage",
        itemId: item.id,
        sourceFileId: item.source_file_id,
        reason: errorClass.reason,
      };
    }

    if (errorClass.type === "permanent") {
      const permanentMessage =
        `Permanent Google Drive failure (${errorClass.reason}): ${message}`;

      errorLog(
        permanentMessage
      );

      await markItemFailed(
        item.id,
        item.lease_generation,
        permanentMessage
      );

      await incrementFailed(
        migrationId,
        permanentMessage
      );

      await finishMigrationIfComplete(
        migrationId
      );

      clearRetryCount(item.id, item.lease_generation);

      throw error;
    }

    if (errorClass.type === "transient") {
      const retryCount =
        await incrementRetryCount(item.id, item.lease_generation);

      if (
        retryCount <=
        MAX_TRANSIENT_RETRIES
      ) {
        warn(
          `Transient failure for ${item.source_file_id}. ` +
          `Retry ${retryCount}/${MAX_TRANSIENT_RETRIES}: ` +
          message
        );

        const retryDelay = Math.min(
          60_000,
          RETRY_DELAY_MS * 2 ** (retryCount - 1)
        );

        await requeueItemAfterTransientFailure(
          item.id,
          item.lease_generation,
          `Transient failure; retry ${retryCount}/${MAX_TRANSIENT_RETRIES}: ${message}`,
          retryDelay
        );

        return {
          status: "retrying",
          itemId: item.id,
          sourceFileId:
            item.source_file_id,
          retryCount,
          workerNumber,
        };
      }

      errorLog(
        `Transient failure persisted after ${MAX_TRANSIENT_RETRIES} retries: ` +
        message
      );
    }

    /*
     * If we created a target file but verification or
     * database switching failed, remove that target file
     * so we do not leave an orphaned copy.
     */
    if (
      targetFileId &&
      createdTargetFile &&
      !mappingCommitted
    ) {
      try {
        const targetDrive =
          await getGoogleDriveClientForAccount(
            targetAccount
          );

        await targetDrive.files.delete({
          fileId: targetFileId,
        }, {
          signal: abortController.signal,
        });
      } catch (cleanupError) {
        errorLog(
          `[MIGRATION ${migrationId}] ` +
          `Target cleanup failed:`,
          cleanupError instanceof Error
            ? cleanupError.message
            : cleanupError
        );
      }
    }

    clearRetryCount(item.id, item.lease_generation);

    await markItemFailed(
      item.id,
      item.lease_generation,
      message
    );

    await incrementFailed(
      migrationId,
      message
    );

    await finishMigrationIfComplete(
      migrationId
    );

    throw error;
  } finally {
    cleanupItemTransferState(item.id);
  }
}

export async function getMigrationSummary(
  migrationId
) {
  const result = await pool.query(
    `
    SELECT
      m.id,
      m.status,
      m.total_files,
      m.completed_files,
      m.failed_files,
      m.cancel_requested,
      m.current_file_id,
      m.error_message,
      m.started_at,
      m.finished_at,
      COUNT(i.id) FILTER (
        WHERE i.status = 'pending'
      ) AS pending_items,
      COUNT(i.id) FILTER (
        WHERE i.status = 'running'
      ) AS running_items,
      COUNT(i.id) FILTER (
        WHERE i.status = 'completed'
      ) AS completed_items,
      COUNT(i.id) FILTER (
        WHERE i.status = 'failed'
      ) AS failed_items
    FROM google_drive_account_migrations m
    LEFT JOIN google_drive_account_migration_items i
      ON i.migration_id = m.id
    WHERE m.id = $1
    GROUP BY m.id
    `,
    [migrationId]
  );

  return result.rows[0] ?? null;
}