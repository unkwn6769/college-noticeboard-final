import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { ArrowLeft, CheckCircle2, HardDrive } from "lucide-react";
import { API_URL } from "../../config/api";

function formatBytes(value) {
  if (!value) return "—";

  const bytes = Number(value);

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes;
  let index = -1;

  do {
    size /= 1024;
    index++;
  } while (size >= 1024 && index < units.length - 1);

  return `${size.toFixed(1)} ${units[index]}`;
}

function AdminAccounts() {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [error, setError] = useState("");
  const [updatingId, setUpdatingId] = useState(null);

  useEffect(() => {
    async function load() {
      try {
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

        const response = await fetch(
          `${API_URL}/api/admin/accounts`,
          {
            credentials: "include",
          }
        );

        if (!response.ok) {
          throw new Error("Failed to load accounts");
        }

        const data = await response.json();
        setAccounts(data.accounts || []);
      } catch (err) {
        console.error(err);
        setError("Failed to load Google Drive accounts.");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  async function toggleAccount(account) {
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

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));

        throw new Error(
          data.error || "Failed to update account"
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

  async function removeAccount(account) {
    const confirmed = window.confirm(
      `Remove ${account.email} from the storage account pool?\n\n` +
      "This will not delete files from Google Drive."
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

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error || "Failed to remove account"
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
    return <Navigate to="/admin/login" replace />;
  }

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
              Connected accounts used by the storage uploader.
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

        <div className="mt-8 space-y-4">
          {accounts.map((account) => {
            const quota = account.quota;

            const usagePercent =
              quota?.limitBytes && quota?.usageBytes
                ? Math.min(
                  100,
                  (Number(quota.usageBytes) /
                    Number(quota.limitBytes)) *
                  100
                )
                : null;

            return (
              <div
                key={account.id}
                className="rounded-2xl border border-slate-200 bg-white p-6"
              >
                <div className="flex items-start justify-between gap-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                      <HardDrive size={20} />
                    </div>

                    <div>
                      <h2 className="text-base font-semibold text-slate-950">
                        {account.email}
                      </h2>

                      <div className="mt-1 flex items-center gap-2 text-xs text-slate-400">
                        <span
                          className={
                            account.status === "connected"
                              ? "h-2 w-2 rounded-full bg-emerald-500"
                              : "h-2 w-2 rounded-full bg-slate-400"
                          }
                        />

                        <span className="capitalize">
                          {account.status}
                        </span>

                        <span>•</span>

                        {account.fileCount.toLocaleString()} mapped files
                      </div>
                    </div>
                  </div>

                  {quota && (
                    <div className="text-right">
                      <div className="text-sm font-semibold text-slate-950">
                        {formatBytes(quota.freeBytes)} free
                      </div>

                      <div className="mt-1 text-xs text-slate-400">
                        {formatBytes(quota.usageBytes)} used of{" "}
                        {formatBytes(quota.limitBytes)}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleAccount(account)}
                      disabled={updatingId === account.id}
                      className={
                        account.status === "connected"
                          ? "rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                          : "rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                      }
                    >
                      {updatingId === account.id
                        ? "Updating..."
                        : account.status === "connected"
                          ? "Disable"
                          : "Enable"}
                    </button>

                    {account.fileCount === 0 && (
                      <button
                        type="button"
                        onClick={() => removeAccount(account)}
                        disabled={updatingId === account.id}
                        className="rounded-xl border border-red-200 px-4 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>

                {usagePercent !== null && (
                  <div className="mt-6">
                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-slate-900"
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
    </div>
  );
}

export default AdminAccounts;
