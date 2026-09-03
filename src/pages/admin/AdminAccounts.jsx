import { useEffect, useRef, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  HardDrive,
  Files,
  X,
} from "lucide-react";
import { API_URL } from "../../config/api";

const ACTIVE_MIGRATION_KEY =
  "college-noticeboard-active-migration";

function formatBytes(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return "—";
  }

  const bytes = Number(value);

  if (!Number.isFinite(bytes)) {
    return "—";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes;
  let index = -1;

  do {
    size /= 1024;
    index++;
  } while (
    size >= 1024 &&
    index < units.length - 1
  );

  return `${size.toFixed(1)} ${units[index]}`;
}

function formatDuration(seconds) {
  if (
    seconds === null ||
    seconds === undefined ||
    !Number.isFinite(Number(seconds))
  ) {
    return "—";
  }

  let remaining = Math.max(
    0,
    Math.round(Number(seconds))
  );

  const hours = Math.floor(
    remaining / 3600
  );

  remaining %= 3600;

  const minutes = Math.floor(
    remaining / 60
  );

  const secs = remaining % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }

  return `${secs}s`;
}

function formatSpeed(bytesPerSecond) {
  if (
    bytesPerSecond === null ||
    bytesPerSecond === undefined ||
    !Number.isFinite(
      Number(bytesPerSecond)
    ) ||
    Number(bytesPerSecond) <= 0
  ) {
    return "—";
  }

  return `${formatBytes(
    Number(bytesPerSecond)
  )}/s`;
}

function AdminAccounts() {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [updatingId, setUpdatingId] =
    useState(null);

  const [migration, setMigration] =
    useState(null);

  const [migrationError, setMigrationError] =
    useState("");

  const [migrationSource, setMigrationSource] =
    useState(null);

  const [selectedTargetId, setSelectedTargetId] =
    useState("");

  const [migrationMode, setMigrationMode] =
    useState("all");

  const [customMigrationLimit, setCustomMigrationLimit] =
    useState("");

  const [migrationTargetSizeMb, setMigrationTargetSizeMb] =
    useState("500");

  const [migrationMinimumFileSizeMb, setMigrationMinimumFileSizeMb] =
    useState("5");

  const [migrationMaximumFileSizeMb, setMigrationMaximumFileSizeMb] =
    useState("20");

  const [migrationMaximumFiles, setMigrationMaximumFiles] =
    useState("100");

  const [migrationModalOpen, setMigrationModalOpen] =
    useState(false);

  const [migrationStarting, setMigrationStarting] =
    useState(false);

  const migrationPollTimerRef = useRef(null);
  const migrationPollGenerationRef = useRef(0);
  const migrationTelemetryRef = useRef({
    migrationId: null,
    sampledAt: 0,
    transferredBytes: 0,
    currentFileId: null,
    currentFileBytes: 0,
  });

  function stopMigrationPolling() {
    migrationPollGenerationRef.current += 1;

    if (migrationPollTimerRef.current !== null) {
      window.clearTimeout(
        migrationPollTimerRef.current
      );
      migrationPollTimerRef.current = null;
    }
  }

  async function loadAccounts() {
    const response = await fetch(
      `${API_URL}/api/admin/accounts`,
      {
        credentials: "include",
      }
    );

    if (!response.ok) {
      throw new Error(
        "Failed to load Google Drive accounts"
      );
    }

    const data = await response.json();

    setAccounts(data.accounts || []);
  }

  useEffect(() => {
    let cancelled = false;

    async function restoreActiveMigration() {
      const migrationId =
        window.localStorage.getItem(
          ACTIVE_MIGRATION_KEY
        );

      if (!migrationId || cancelled) {
        return;
      }

      try {
        const latest =
          await getMigrationStatus(
            migrationId
          );

        if (cancelled) {
          return;
        }

        if (!latest) {
          window.localStorage.removeItem(
            ACTIVE_MIGRATION_KEY
          );
          return;
        }

        setMigration(latest);

        if (
          latest.status === "pending" ||
          latest.status === "running" ||
          latest.status ===
            "waiting_for_storage"
        ) {
          void pollMigration(migrationId);
          return;
        }

        window.localStorage.removeItem(
          ACTIVE_MIGRATION_KEY
        );
      } catch (error) {
        if (!cancelled) {
          console.error(
            "Failed to restore active migration:",
            error
          );
        }
      }
    }

    async function load() {
      try {
        const params = new URLSearchParams(window.location.search);
        const oauthError = params.get("error");
        const connected = params.get("connected");

        if (oauthError) {
          setError(oauthError);
        } else if (connected === "1") {
          setSuccess("Google Drive account connected successfully.");
        }

        if (oauthError || connected === "1") {
          window.history.replaceState({}, document.title, window.location.pathname);
        }

        const sessionResponse = await fetch(
          `${API_URL}/api/admin/auth/me`,
          {
            credentials: "include",
          }
        );

        if (!sessionResponse.ok) {
          setAuthenticated(false);
          return;
        }

        setAuthenticated(true);

        await loadAccounts();
        await restoreActiveMigration();
      } catch (err) {
        if (!cancelled) {
          console.error(err);

          setError(
            err instanceof Error
              ? err.message
              : "Failed to load Google Drive accounts."
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
      stopMigrationPolling();
    };
  }, []);

  async function toggleAccount(account) {
    setError("");

    const nextStatus =
      account.status === "connected"
        ? "disabled"
        : "connected";

    try {
      setUpdatingId(account.id);

      const response = await fetch(
        `${API_URL}/api/admin/accounts/${encodeURIComponent(
          account.id
        )}/status`,
        {
          method: "PATCH",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            status: nextStatus,
          }),
        }
      );

      const data =
        await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error ||
          "Failed to update account"
        );
      }

      setAccounts((current) =>
        current.map((item) =>
          item.id === account.id
            ? {
              ...item,
              status: nextStatus,
            }
            : item
        )
      );
    } catch (error) {
      console.error(error);

      setError(
        error instanceof Error
          ? error.message
          : "Failed to update account"
      );
    } finally {
      setUpdatingId(null);
    }
  }

  function openMigrationModal(account) {
    setError("");
    setSuccess("");
    setMigrationError("");

    const targets = accounts.filter(
      (item) =>
        item.id !== account.id &&
        item.status === "connected"
    );

    if (targets.length === 0) {
      setError(
        "No other connected Google Drive account is available as a migration target."
      );
      return;
    }

    setMigrationSource(account);
    setSelectedTargetId("");
    setMigrationMode("all");
    setCustomMigrationLimit("");
    setMigrationModalOpen(true);
  }

  function closeMigrationModal() {
    if (
      migrationStarting ||
      migration?.status === "pending" ||
      migration?.status === "running" ||
      migration?.status ===
        "waiting_for_storage"
    ) {
      return;
    }

    setMigrationModalOpen(false);
    setMigrationSource(null);
    setSelectedTargetId("");
    setMigrationMode("all");
    setCustomMigrationLimit("");
    setMigrationError("");
  }

  async function getMigrationStatus(
    migrationId
  ) {
    const response = await fetch(
      `${API_URL}/api/admin/migrations/${encodeURIComponent(
        migrationId
      )}`,
      {
        credentials: "include",
      }
    );

    const data =
      await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.error ||
        "Failed to load migration status"
      );
    }

    return data.migration;
  }

  function enrichLiveTelemetry(latest) {
    if (!latest?.live) {
      return latest;
    }

    const now = Date.now();
    const live = latest.live;
    const currentFile = live.currentFile;

    const totalBytes = Number(
      live.transferredBytes ?? 0
    );

    let overallSpeed =
      Number(
        live.overallSpeedBytesPerSecond ?? 0
      );

    let totalEta =
      live.totalEtaSeconds ?? null;

    let currentFileSpeed =
      Number(
        currentFile?.speedBytesPerSecond ?? 0
      );

    let currentFileEta =
      currentFile?.etaSeconds ?? null;

    const previous =
      migrationTelemetryRef.current;

    if (
      previous.migrationId === latest.id &&
      previous.sampledAt > 0
    ) {
      const elapsed =
        (now - previous.sampledAt) /
        1000;

      if (
        elapsed >= 0.5 &&
        elapsed <= 10
      ) {
        const byteDelta =
          totalBytes -
          previous.transferredBytes;

        if (byteDelta > 0) {
          overallSpeed =
            byteDelta / elapsed;
        }

        const currentFileBytes =
          Number(
            currentFile?.bytesTransferred ??
              0
          );

        if (
          currentFile?.id ===
            previous.currentFileId &&
          currentFileBytes >=
            previous.currentFileBytes &&
          currentFileBytes >
            previous.currentFileBytes
        ) {
          currentFileSpeed =
            (
              currentFileBytes -
              previous.currentFileBytes
            ) / elapsed;
        }
      }
    }

    const totalSizeBytes = Number(
      live.totalBytes ?? 0
    );

    const remainingTotalBytes =
      Math.max(
        0,
        totalSizeBytes - totalBytes
      );

    if (
      latest.status === "completed"
    ) {
      totalEta = 0;
    } else if (
      overallSpeed > 0 &&
      remainingTotalBytes > 0
    ) {
      totalEta =
        remainingTotalBytes /
        overallSpeed;
    } else if (
      remainingTotalBytes === 0 &&
      latest.status === "running"
    ) {
      totalEta = 0;
    }

    if (
      currentFile &&
      currentFileSpeed > 0
    ) {
      const fileSize =
        Number(
          currentFile.sizeBytes ?? 0
        );

      const fileBytes =
        Number(
          currentFile.bytesTransferred ??
            0
        );

      currentFileEta =
        Math.max(
          0,
          fileSize - fileBytes
        ) / currentFileSpeed;
    }

    migrationTelemetryRef.current = {
      migrationId: latest.id,
      sampledAt: now,
      transferredBytes: totalBytes,
      currentFileId:
        currentFile?.id ?? null,
      currentFileBytes: Number(
        currentFile?.bytesTransferred ??
          0
      ),
    };

    return {
      ...latest,
      live: {
        ...live,
        overallSpeedBytesPerSecond:
          overallSpeed,
        totalEtaSeconds: totalEta,
        currentFile: currentFile
          ? {
              ...currentFile,
              speedBytesPerSecond:
                currentFileSpeed,
              etaSeconds:
                currentFileEta,
            }
          : currentFile,
      },
    };
  }

  async function pollMigration(migrationId) {
    stopMigrationPolling();

    const generation =
      migrationPollGenerationRef.current;

    const check = async () => {
      if (
        generation !==
        migrationPollGenerationRef.current
      ) {
        return;
      }

      try {
        const latest =
          await getMigrationStatus(
            migrationId
          );

        const enrichedLatest =
          enrichLiveTelemetry(
            latest
          );

        if (
          generation !==
          migrationPollGenerationRef.current
        ) {
          return;
        }

        setMigration(
          enrichedLatest
        );

        if (
          enrichedLatest.status === "completed"
        ) {
          window.localStorage.removeItem(
            ACTIVE_MIGRATION_KEY
          );

          await loadAccounts();

          const safeToDelete =
            enrichedLatest.fileLimit === null &&
            enrichedLatest.totalFiles > 0 &&
            enrichedLatest.transferredFiles ===
              enrichedLatest.totalFiles &&
            enrichedLatest.sourceDeletedFiles ===
              enrichedLatest.totalFiles &&
            enrichedLatest.cleanupFailedFiles === 0 &&
            enrichedLatest.pendingFiles === 0 &&
            enrichedLatest.runningFiles === 0 &&
            enrichedLatest.failedFiles === 0;

          if (!safeToDelete) {
            setMigrationError(
              enrichedLatest.fileLimit !== null
                ? "Migration test completed successfully. The source account was not removed because this was a limited migration."
                : "Migration completed, but the source account was not removed because cleanup is incomplete."
            );
            return;
          }

          setMigrationError(
            "Migration completed successfully. The source account is eligible for removal."
          );

          return;
        }

        if (
          enrichedLatest.status === "failed" ||
          enrichedLatest.status === "cancelled"
        ) {
          window.localStorage.removeItem(
            ACTIVE_MIGRATION_KEY
          );

          setMigrationError(
            enrichedLatest.errorMessage ||
            `Migration ${enrichedLatest.status}.`
          );

          return;
        }

        migrationPollTimerRef.current =
          window.setTimeout(() => {
            void check();
          }, 1000);
      } catch (error) {
        if (
          generation !==
          migrationPollGenerationRef.current
        ) {
          return;
        }

        console.error(error);

        setMigrationError(
          error instanceof Error
            ? error.message
            : "Failed to check migration status"
        );

        migrationPollTimerRef.current =
          window.setTimeout(() => {
            void check();
          }, 5000);
      }
    };

    await check();
  }

  async function startMigration() {
    if (!migrationSource) {
      return;
    }

    if (!selectedTargetId) {
      setMigrationError(
        "Choose a destination Google Drive account."
      );
      return;
    }

    const target = accounts.find(
      (item) => item.id === selectedTargetId
    );

    if (!target) {
      setMigrationError(
        "Selected target account was not found."
      );
      return;
    }

    let migrationLimit;
    let sizeSelection = null;

    if (migrationMode === "custom") {
      const parsedLimit =
        Number(customMigrationLimit);

      if (
        !Number.isInteger(parsedLimit) ||
        parsedLimit < 1
      ) {
        setMigrationError(
          "Enter a valid migration amount of at least 1."
        );
        return;
      }

      if (
        parsedLimit >
        migrationSource.fileCount
      ) {
        setMigrationError(
          `You can migrate at most ${migrationSource.fileCount.toLocaleString()} files.`
        );
        return;
      }

      migrationLimit = parsedLimit;
    }

    if (migrationMode === "size") {
      const targetSizeMb =
        Number(migrationTargetSizeMb);

      const minimumFileSizeMb =
        Number(migrationMinimumFileSizeMb);

      const maximumFileSizeMb =
        Number(migrationMaximumFileSizeMb);

      const maximumFiles =
        Number(migrationMaximumFiles);

      if (
        !Number.isFinite(targetSizeMb) ||
        targetSizeMb <= 0
      ) {
        setMigrationError(
          "Enter a valid target size greater than 0 MB."
        );
        return;
      }

      if (
        !Number.isFinite(minimumFileSizeMb) ||
        minimumFileSizeMb < 0
      ) {
        setMigrationError(
          "Enter a valid minimum file size of 0 MB or more."
        );
        return;
      }

      if (
        !Number.isFinite(maximumFileSizeMb) ||
        maximumFileSizeMb <= 0
      ) {
        setMigrationError(
          "Enter a valid maximum file size greater than 0 MB."
        );
        return;
      }

      if (
        maximumFileSizeMb < minimumFileSizeMb
      ) {
        setMigrationError(
          "Maximum file size must be at least the minimum file size."
        );
        return;
      }

      if (
        !Number.isInteger(maximumFiles) ||
        maximumFiles < 1
      ) {
        setMigrationError(
          "Enter a valid maximum file count of at least 1."
        );
        return;
      }

      if (
        maximumFiles >
        migrationSource.fileCount
      ) {
        setMigrationError(
          `You can select at most ${migrationSource.fileCount.toLocaleString()} files.`
        );
        return;
      }

      sizeSelection = {
        targetSizeBytes: Math.round(
          targetSizeMb * 1024 * 1024
        ),
        minimumFileSizeBytes: Math.round(
          minimumFileSizeMb * 1024 * 1024
        ),
        maximumFileSizeBytes: Math.round(
          maximumFileSizeMb * 1024 * 1024
        ),
        maxFileCount: maximumFiles,
      };
    }

    setMigrationError("");
    setError("");
    setMigrationStarting(true);

    try {
      const response = await fetch(
        `${API_URL}/api/admin/accounts/${encodeURIComponent(
          migrationSource.id
        )}/migration`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            targetAccountId: target.id,
            selectionMode:
              migrationMode === "size"
                ? "size"
                : migrationMode === "custom"
                  ? "count"
                  : "all",
            ...(migrationMode === "custom"
              ? {
                limit: migrationLimit,
              }
              : {}),
            ...(migrationMode === "size"
              ? sizeSelection
              : {}),
          }),
        }
      );

      const data =
        await response
          .json()
          .catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error ||
          "Failed to start migration"
        );
      }

      const initialMigration =
        data.migration;

      window.localStorage.setItem(
        ACTIVE_MIGRATION_KEY,
        initialMigration.id
      );

      setMigration({
        ...initialMigration,
        sourceEmail:
          migrationSource.email,
        targetEmail:
          target.email,
        transferredFiles:
          initialMigration.completedFiles ??
          0,
        sourceDeletedFiles: 0,
        cleanupFailedFiles: 0,
        pendingFiles:
          initialMigration.totalFiles,
        runningFiles: 0,
        live: {
          totalBytes: "0",
          transferredBytes: "0",
          overallSpeedBytesPerSecond: 0,
          totalEtaSeconds: null,
          migrationElapsedSeconds: 0,
          currentFile: null,
        },
      });

      setMigrationModalOpen(false);
      setSelectedTargetId("");
      setMigrationMode("all");
      setCustomMigrationLimit("");
      setMigrationTargetSizeMb("500");
      setMigrationMinimumFileSizeMb("5");
      setMigrationMaximumFileSizeMb("20");
      setMigrationMaximumFiles("100");

      void pollMigration(
        initialMigration.id
      );
    } catch (error) {
      console.error(error);

      setMigrationError(
        error instanceof Error
          ? error.message
          : "Failed to start migration"
      );
    } finally {
      setMigrationStarting(false);
    }
  }

  async function removeAccount(account) {
    setError("");
    setMigrationError("");

    if (account.fileCount > 0) {
      openMigrationModal(account);
      return;
    }

    const confirmed = window.confirm(
      `Remove ${account.email} from the storage account pool?\n\n` +
      "This account has no mapped files."
    );

    if (!confirmed) {
      return;
    }

    try {
      setUpdatingId(account.id);

      const response = await fetch(
        `${API_URL}/api/admin/accounts/${encodeURIComponent(
          account.id
        )}`,
        {
          method: "DELETE",
          credentials: "include",
        }
      );

      const data =
        await response
          .json()
          .catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error ||
          "Failed to remove account"
        );
      }

      setAccounts((current) =>
        current.filter(
          (item) => item.id !== account.id
        )
      );
    } catch (error) {
      console.error(error);

      setError(
        error instanceof Error
          ? error.message
          : "Failed to remove account"
      );
    } finally {
      setUpdatingId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <span className="text-sm text-slate-500">
          Loading accounts...
        </span>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <Navigate
        to="/admin/login"
        replace
      />
    );
  }

  const targetAccounts =
    migrationSource
      ? accounts.filter(
        (item) =>
          item.id !==
          migrationSource.id &&
          item.status === "connected"
      )
      : [];

  const migrationComplete =
    migration?.status === "completed" &&
    migration.transferredFiles ===
    migration.totalFiles &&
    migration.sourceDeletedFiles ===
    migration.totalFiles &&
    migration.cleanupFailedFiles === 0;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center px-6 py-5">
          <Link
            to="/admin"
            className="flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-900"
          >
            <ArrowLeft size={16} />
            Admin
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex items-end justify-between gap-6">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              Storage
            </div>

            <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
              Google Drive Accounts
            </h1>

            <p className="mt-2 text-sm text-slate-500">
              Connect Google Drive accounts through OAuth. Once the OAuth client is published for production, new Drive accounts do not need to be added individually as Google Cloud test users.
            </p>
          </div>

          <a
            href={`${API_URL}/api/admin/accounts/google/start`}
            className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            + Add Google Account
          </a>
        </div>

        {error && (
          <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {success && (
          <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700">
            {success}
          </div>
        )}

        {migrationError && (
          <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {migrationError}
          </div>
        )}

        {migration && (
          <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-6">
            <div className="flex items-start justify-between gap-6">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Migration
                </div>

                <h2 className="mt-2 text-lg font-semibold text-slate-950">
                  {migration.sourceEmail}
                  {" → "}
                  {migration.targetEmail}
                </h2>
              </div>

              <div className="text-right">
                <div className="text-2xl font-bold text-slate-950">
                  {migration.progress ?? 0}%
                </div>

                <div className="text-xs capitalize text-slate-400">
                  {migration.status}
                </div>
              </div>
            </div>

            <div className="mt-6 h-3 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-slate-900 transition-all duration-500"
                style={{
                  width: `${Math.min(
                    100,
                    Math.max(
                      0,
                      migration.progress ?? 0
                    )
                  )}%`,
                }}
              />
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <div>
                <div className="text-sm text-slate-400">
                  Transferred
                </div>

                <div className="mt-1 font-semibold text-slate-950">
                  {Number(
                    migration.transferredFiles ?? 0
                  ).toLocaleString()}
                  {" / "}
                  {Number(
                    migration.totalFiles ?? 0
                  ).toLocaleString()}
                </div>
              </div>

              <div>
                <div className="text-sm text-slate-400">
                  Source deleted
                </div>

                <div className="mt-1 font-semibold text-slate-950">
                  {Number(
                    migration.sourceDeletedFiles ??
                    0
                  ).toLocaleString()}
                  {" / "}
                  {Number(
                    migration.totalFiles ?? 0
                  ).toLocaleString()}
                </div>
              </div>

              <div>
                <div className="text-sm text-slate-400">
                  Cleanup failures
                </div>

                <div className="mt-1 font-semibold text-slate-950">
                  {Number(
                    migration.cleanupFailedFiles ??
                    0
                  ).toLocaleString()}
                </div>
              </div>
            </div>

            {migration.live && (
              <div className="mt-6 space-y-4">
                {migration.live.currentFile && (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                          Current file
                        </div>

                        <h3 className="mt-2 break-words text-base font-semibold text-slate-950">
                          {migration.live.currentFile.name ||
                            migration.currentFileId ||
                            "Processing file"}
                        </h3>

                        <div className="mt-1 text-xs capitalize text-slate-500">
                          {migration.live.currentFile.phase
                            ? migration.live.currentFile.phase.replaceAll(
                                "_",
                                " "
                              )
                            : "transferring"}
                        </div>

                        {migration.live.currentFile.targetAccountId && (
                          <div className="mt-1 text-xs text-slate-400">
                            Target:{" "}
                            {accounts.find(
                              (account) =>
                                account.id ===
                                migration.live.currentFile
                                  .targetAccountId
                            )?.email ||
                              migration.targetEmail}
                          </div>
                        )}
                      </div>

                      <div className="text-left lg:text-right">
                        <div className="text-lg font-bold text-slate-950">
                          {formatBytes(
                            migration.live.currentFile
                              .bytesTransferred
                          )}{" "}
                          /{" "}
                          {formatBytes(
                            migration.live.currentFile
                              .sizeBytes
                          )}
                        </div>

                        <div className="mt-1 text-xs text-slate-500">
                          {formatSpeed(
                            migration.live.currentFile
                              .speedBytesPerSecond
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 h-2 overflow-hidden rounded-full bg-white">
                      <div
                        className="h-full rounded-full bg-slate-900 transition-all duration-300"
                        style={{
                          width: `${
                            Number(
                              migration.live.currentFile
                                .sizeBytes ?? 0
                            ) > 0
                              ? Math.min(
                                  100,
                                  (
                                    Number(
                                      migration.live
                                        .currentFile
                                        .bytesTransferred ??
                                        0
                                    ) /
                                      Number(
                                        migration.live
                                          .currentFile
                                          .sizeBytes ??
                                          0
                                      )
                                  ) *
                                    100
                                )
                              : 0
                          }%`,
                        }}
                      />
                    </div>

                    <div className="mt-4 grid gap-4 sm:grid-cols-3">
                      <div>
                        <div className="text-xs text-slate-400">
                          Live speed
                        </div>

                        <div className="mt-1 text-sm font-semibold text-slate-950">
                          {formatSpeed(
                            migration.live.currentFile
                              .speedBytesPerSecond
                          )}
                        </div>
                      </div>

                      <div>
                        <div className="text-xs text-slate-400">
                          File ETA
                        </div>

                        <div className="mt-1 text-sm font-semibold text-slate-950">
                          {formatDuration(
                            migration.live.currentFile
                              .etaSeconds
                          )}
                        </div>
                      </div>

                      <div>
                        <div className="text-xs text-slate-400">
                          File elapsed
                        </div>

                        <div className="mt-1 text-sm font-semibold text-slate-950">
                          {formatDuration(
                            migration.live.currentFile
                              .elapsedSeconds
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-xl bg-slate-50 p-4">
                    <div className="text-xs text-slate-400">
                      Data transferred
                    </div>

                    <div className="mt-1 text-sm font-semibold text-slate-950">
                      {formatBytes(
                        migration.live
                          .transferredBytes
                      )}{" "}
                      /{" "}
                      {formatBytes(
                        migration.live.totalBytes
                      )}
                    </div>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <div className="text-xs text-slate-400">
                      Live speed
                    </div>

                    <div className="mt-1 text-sm font-semibold text-slate-950">
                      {formatSpeed(
                        migration.live
                          .overallSpeedBytesPerSecond
                      )}
                    </div>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <div className="text-xs text-slate-400">
                      Total ETA
                    </div>

                    <div className="mt-1 text-sm font-semibold text-slate-950">
                      {formatDuration(
                        migration.live.totalEtaSeconds
                      )}
                    </div>
                  </div>

                  <div className="rounded-xl bg-slate-50 p-4">
                    <div className="text-xs text-slate-400">
                      Duration
                    </div>

                    <div className="mt-1 text-sm font-semibold text-slate-950">
                      {formatDuration(
                        migration.live
                          .migrationElapsedSeconds
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {migrationComplete && (
              <div className="mt-6 rounded-xl bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={18} />

                  Migration completed successfully.
                </div>

                {migration.fileLimit !== null ? (
                  <div className="mt-2 text-sm font-normal">
                    {Number(
                      migration.transferredFiles
                    ).toLocaleString()}{" "}
                    files were migrated. The source account was not removed.
                  </div>
                ) : (
                  <div className="mt-2 text-sm font-normal">
                    All files were migrated and the source account is eligible for removal.
                  </div>
                )}
              </div>
            )}

            {migration?.status ===
            "waiting_for_storage" ? (
              <div className="mt-4 text-sm text-amber-700">
                Migration is paused because no connected Google Drive account
                currently has enough free storage. The server will retry
                automatically.
              </div>
            ) : migration?.status === "pending" ||
              migration?.status === "running" ? (
              <div className="mt-4 text-sm text-slate-500">
                Migration is being processed by the server. You can leave this
                page open to watch progress.
              </div>
            ) : null}

          </div>
        )}

        <div className="mt-8 space-y-4">
          {accounts.map((account) => {
            const quota = account.quota;

            const usagePercent =
              quota?.limitBytes &&
                quota?.usageBytes
                ? Math.min(
                  100,
                  (Number(
                    quota.usageBytes
                  ) /
                    Number(
                      quota.limitBytes
                    )) *
                  100
                )
                : null;

            const sourceIsMigrating =
              migration?.sourceAccountId ===
              account.id &&
              (migration.status === "pending" ||
                migration.status === "running" ||
                migration.status ===
                  "waiting_for_storage");

            return (
              <div
                key={account.id}
                className="rounded-2xl border border-slate-200 bg-white p-6"
              >
                <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                  <div className="flex items-start gap-4">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                      <HardDrive size={20} />
                    </div>

                    <Link
                      to={`/admin/accounts/${encodeURIComponent(account.id)}/files`}
                      className="group rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2"
                    >
                      <h2 className="text-base font-semibold text-slate-950 transition group-hover:text-slate-700">
                        {account.email}
                      </h2>

                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                        <span
                          className={
                            account.status ===
                              "connected"
                              ? "h-2 w-2 rounded-full bg-emerald-500"
                              : "h-2 w-2 rounded-full bg-slate-400"
                          }
                        />

                        <span className="capitalize">
                          {account.status}
                        </span>

                        <span>•</span>

                        <span>
                          {account.fileCount.toLocaleString()} mapped files
                        </span>
                      </div>
                    </Link>
                  </div>

                  <div className="flex flex-col gap-4 lg:items-end">
                    {quota && (
                      <div className="text-left lg:text-right">
                        <div className="text-sm font-semibold text-slate-950">
                          {formatBytes(
                            quota.freeBytes
                          )}{" "}
                          free
                        </div>

                        <div className="mt-1 text-xs text-slate-400">
                          {formatBytes(
                            quota.usageBytes
                          )}{" "}
                          used of{" "}
                          {formatBytes(
                            quota.limitBytes
                          )}
                        </div>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to={`/admin/accounts/${encodeURIComponent(account.id)}/files`}
                        className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        <Files size={16} />
                        Browse files
                      </Link>

                      <button
                        type="button"
                        onClick={() =>
                          toggleAccount(
                            account
                          )
                        }
                        disabled={
                          updatingId ===
                          account.id ||
                          sourceIsMigrating
                        }
                        className={
                          account.status ===
                            "connected"
                            ? "rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                            : "rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                        }
                      >
                        {updatingId ===
                          account.id
                          ? "Updating..."
                          : account.status ===
                            "connected"
                            ? "Disable"
                            : "Enable"}
                      </button>

                      <button
                        type="button"
                        onClick={() =>
                          removeAccount(
                            account
                          )
                        }
                        disabled={
                          updatingId ===
                          account.id ||
                          sourceIsMigrating
                        }
                        className="rounded-xl border border-red-200 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
                      >
                        {sourceIsMigrating
                          ? "Migrating..."
                          : account.fileCount >
                            0
                            ? "Remove"
                            : "Remove"}
                      </button>
                    </div>
                  </div>
                </div>

                {usagePercent !== null && (
                  <div className="mt-6">
                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-slate-900 transition-all"
                        style={{
                          width: `${usagePercent}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </main>

      {migrationModalOpen &&
        migrationSource && (
          <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-950/40 p-4 sm:p-6">
            <div className="max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                    Move files before removal
                  </div>

                  <h2 className="mt-2 text-xl font-bold text-slate-950">
                    {migrationSource.email}
                  </h2>

                  <p className="mt-2 text-sm text-slate-500">
                    Choose a destination and how many files to migrate. A custom or limited migration will not remove the source account.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={
                    closeMigrationModal
                  }
                  disabled={
                    migrationStarting ||
                    migration?.status === "pending" ||
                    migration?.status === "running" ||
                    migration?.status ===
                    "waiting_for_storage"
                  }
                  className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="mt-6">
                <label
                  htmlFor="migration-target"
                  className="text-sm font-semibold text-slate-900"
                >
                  Destination account
                </label>

                <select
                  id="migration-target"
                  value={selectedTargetId}
                  onChange={(event) =>
                    setSelectedTargetId(
                      event.target.value
                    )
                  }
                  disabled={
                    migrationStarting ||
                    migration?.status === "pending" ||
                    migration?.status === "running" ||
                    migration?.status ===
                    "waiting_for_storage"
                  }
                  className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 outline-none focus:border-slate-400"
                >
                  <option value="">
                    Select a connected account
                  </option>

                  {targetAccounts.map(
                    (target) => (
                      <option
                        key={target.id}
                        value={target.id}
                      >
                        {target.email} —{" "}
                        {target.fileCount.toLocaleString()} mapped files
                      </option>
                    )
                  )}
                </select>
              </div>

              <div className="mt-6">
                <div className="text-sm font-semibold text-slate-900">
                  Files to migrate
                </div>

                <div className="mt-3 space-y-3">
                  <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4 hover:bg-slate-50">
                    <input
                      type="radio"
                      name="migration-mode"
                      value="all"
                      checked={
                        migrationMode === "all"
                      }
                      onChange={() =>
                        setMigrationMode("all")
                      }
                      disabled={
                        migrationStarting ||
                        migration?.status === "pending" ||
                        migration?.status === "running" ||
                        migration?.status ===
                        "waiting_for_storage"
                      }
                      className="mt-1"
                    />

                    <div>
                      <div className="text-sm font-semibold text-slate-900">
                        All files
                      </div>

                      <div className="mt-1 text-xs text-slate-500">
                        Migrate all{" "}
                        {migrationSource.fileCount.toLocaleString()}{" "}
                        currently mapped files
                      </div>
                    </div>
                  </label>

                  <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4 hover:bg-slate-50">
                    <input
                      type="radio"
                      name="migration-mode"
                      value="custom"
                      checked={
                        migrationMode === "custom"
                      }
                      onChange={() =>
                        setMigrationMode("custom")
                      }
                      disabled={
                        migrationStarting ||
                        migration?.status === "pending" ||
                        migration?.status === "running" ||
                        migration?.status ===
                        "waiting_for_storage"
                      }
                      className="mt-1"
                    />

                    <div className="flex-1">
                      <div className="text-sm font-semibold text-slate-900">
                        Custom amount
                      </div>

                      <div className="mt-1 text-xs text-slate-500">
                        Choose how many files to migrate now
                      </div>

                      {migrationMode === "custom" && (
                        <div className="mt-3">
                          <input
                            type="number"
                            min="1"
                            max={migrationSource.fileCount}
                            step="1"
                            value={customMigrationLimit}
                            onChange={(event) =>
                              setCustomMigrationLimit(
                                event.target.value
                              )
                            }
                            disabled={
                              migrationStarting ||
                              migration?.status === "pending" ||
                              migration?.status === "running" ||
                              migration?.status ===
                              "waiting_for_storage"
                            }
                            placeholder="e.g. 100"
                            className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-900 outline-none focus:border-slate-400"
                          />

                          <div className="mt-2 text-xs text-slate-400">
                            Maximum:{" "}
                            {migrationSource.fileCount.toLocaleString()}{" "}
                            files
                          </div>
                        </div>
                      )}
                    </div>
                  </label>

                  <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4 hover:bg-slate-50">
                    <input
                      type="radio"
                      name="migration-mode"
                      value="size"
                      checked={migrationMode === "size"}
                      onChange={() =>
                        setMigrationMode("size")
                      }
                      disabled={
                        migrationStarting ||
                        migration?.status === "pending" ||
                        migration?.status === "running" ||
                        migration?.status ===
                          "waiting_for_storage"
                      }
                      className="mt-1"
                    />

                    <div className="flex-1">
                      <div className="text-sm font-semibold text-slate-900">
                        Total size
                      </div>

                      <div className="mt-1 text-xs text-slate-500">
                        Select larger files until the requested total size is reached.
                      </div>

                      {migrationMode === "size" && (
                        <div className="mt-3 space-y-3">
                          <div>
                            <label className="text-xs font-medium text-slate-600">
                              Target size (MB)
                            </label>

                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={migrationTargetSizeMb}
                              onChange={(event) =>
                                setMigrationTargetSizeMb(
                                  event.target.value
                                )
                              }
                              disabled={
                                migrationStarting ||
                                migration?.status === "pending" ||
                                migration?.status === "running" ||
                                migration?.status ===
                                  "waiting_for_storage"
                              }
                              placeholder="e.g. 500"
                              className="mt-1 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-900 outline-none focus:border-slate-400"
                            />
                          </div>

                          <div>
                            <label className="text-xs font-medium text-slate-600">
                              Minimum file size (MB)
                            </label>

                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={migrationMinimumFileSizeMb}
                              onChange={(event) =>
                                setMigrationMinimumFileSizeMb(
                                  event.target.value
                                )
                              }
                              disabled={
                                migrationStarting ||
                                migration?.status === "pending" ||
                                migration?.status === "running" ||
                                migration?.status ===
                                  "waiting_for_storage"
                              }
                              placeholder="e.g. 5"
                              className="mt-1 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-900 outline-none focus:border-slate-400"
                            />
                          </div>

                          <div>
                            <label className="text-xs font-medium text-slate-600">
                              Maximum file size (MB)
                            </label>

                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={migrationMaximumFileSizeMb}
                              onChange={(event) =>
                                setMigrationMaximumFileSizeMb(
                                  event.target.value
                                )
                              }
                              disabled={
                                migrationStarting ||
                                migration?.status === "pending" ||
                                migration?.status === "running" ||
                                migration?.status ===
                                  "waiting_for_storage"
                              }
                              placeholder="e.g. 20"
                              className="mt-1 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-900 outline-none focus:border-slate-400"
                            />

                            <div className="mt-1 text-xs text-slate-400">
                              Files larger than this are excluded.
                            </div>
                          </div>

                          <div>
                            <label className="text-xs font-medium text-slate-600">
                              Maximum files
                            </label>

                            <input
                              type="number"
                              min="1"
                              max={migrationSource.fileCount}
                              step="1"
                              value={migrationMaximumFiles}
                              onChange={(event) =>
                                setMigrationMaximumFiles(
                                  event.target.value
                                )
                              }
                              disabled={
                                migrationStarting ||
                                migration?.status === "pending" ||
                                migration?.status === "running" ||
                                migration?.status ===
                                  "waiting_for_storage"
                              }
                              placeholder="e.g. 100"
                              className="mt-1 w-full rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-900 outline-none focus:border-slate-400"
                            />

                            <div className="mt-1 text-xs text-slate-400">
                              Stops at the file limit even if the target size has not been reached.
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </label>
                </div>
              </div>

              <div className="mt-6 rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
                Files are copied and verified first. The old Drive file is deleted only after the application mapping has been switched successfully.
              </div>

              {migrationError && (
                <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                  {migrationError}
                </div>
              )}

              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={
                    closeMigrationModal
                  }
                  disabled={
                    migrationStarting ||
                    migration?.status === "pending" ||
                    migration?.status === "running" ||
                    migration?.status ===
                    "waiting_for_storage"
                  }
                  className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  Cancel
                </button>

                <button
                  type="button"
                  onClick={startMigration}
                  disabled={
                    !selectedTargetId ||
                    migrationStarting ||
                    migration?.status === "pending" ||
                    migration?.status === "running" ||
                    migration?.status ===
                    "waiting_for_storage" ||
                    (migrationMode === "custom" &&
                      !customMigrationLimit) ||
                    (migrationMode === "size" &&
                      (!migrationTargetSizeMb ||
                        !migrationMinimumFileSizeMb ||
                        !migrationMaximumFiles))
                  }
                  className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {migrationStarting
                    ? "Starting..."
                    : "Start Migration"}
                </button>
              </div>
            </div>
          </div>
        )}
    </div>
  );
}

export default AdminAccounts;