import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, HardDrive, RefreshCw, AlertTriangle, BarChart3, ShieldCheck } from "lucide-react";
import { Link, Navigate } from "react-router-dom";
import { API_URL } from "../../config/api";

function formatBytes(value) {
  if (value === null || value === undefined || value === "") return "—";
  try {
    const bytes = BigInt(value);
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let unit = 0;
    let whole = bytes;
    while (whole >= 1024n && unit < units.length - 1) {
      whole /= 1024n;
      unit += 1;
    }
    if (unit === 0) return `${whole} ${units[unit]}`;
    const divisor = 1024 ** unit;
    const numeric = Number(bytes) / divisor;
    return `${numeric.toFixed(numeric >= 100 ? 0 : numeric >= 10 ? 1 : 2)} ${units[unit]}`;
  } catch {
    return "—";
  }
}

function formatPercent(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)}%` : "—";
}

function formatDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function usageBarClass(percent) {
  const value = Number(percent);
  if (!Number.isFinite(value)) return "bg-slate-300";
  if (value >= 90) return "bg-red-500";
  if (value >= 75) return "bg-amber-500";
  return "bg-emerald-500";
}

function AdminStorage() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");

  const loadSummary = useCallback(async (refresh = false, signal) => {
    setError("");
    if (refresh) setRefreshing(true);

    try {
      if (refresh) {
        const response = await fetch(`${API_URL}/api/admin/storage/refresh`, {
          method: "POST",
          credentials: "include",
          signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Failed to refresh storage");
        setSummary(data.summary);
      } else {
        const response = await fetch(`${API_URL}/api/admin/storage/summary`, {
          credentials: "include",
          signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Failed to load storage");
        setSummary(data.summary);
      }
    } catch (err) {
      if (err?.name !== "AbortError") {
        console.error(err);
        setError(err instanceof Error ? err.message : "Failed to load storage summary");
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function initialize() {
      try {
        const response = await fetch(`${API_URL}/api/admin/auth/me`, {
          credentials: "include",
          signal: controller.signal,
        });
        if (!response.ok) {
          setAuthenticated(false);
          setLoading(false);
          return;
        }
        setAuthenticated(true);
        await loadSummary(false, controller.signal);
      } catch (err) {
        if (err?.name !== "AbortError") {
          setError("Failed to initialize storage dashboard");
          setLoading(false);
        }
      }
    }
    initialize();
    return () => controller.abort();
  }, [loadSummary]);

  async function refresh() {
    await loadSummary(true);
  }

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Loading storage dashboard...</div>;
  }

  if (!authenticated) return <Navigate to="/admin/login" replace />;

  const complete = summary?.complete !== false;
  const accounts = summary?.accounts || [];

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Link to="/admin" className="flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-900">
            <ArrowLeft size={16} />
            Admin
          </Link>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Refreshing..." : "Refresh storage"}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Storage</div>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Combined Total Storage</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
            Aggregate capacity across all connected Google Drive accounts, with a separate breakdown for each account.
          </p>
        </div>

        {error && <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

        {summary && (
          <>
            {!complete && (
              <div className="mt-6 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                <div>
                  Combined totals currently include only accounts with a successful quota reading. {summary.unavailableAccounts} connected account{summary.unavailableAccounts === 1 ? " is" : "s are"} unavailable, so the aggregate is partial.
                </div>
              </div>
            )}

            <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Total storage</div>
                  <div className="mt-2 text-4xl font-bold tracking-tight text-slate-950">{formatBytes(summary.totalCapacityBytes)}</div>
                  <div className="mt-1 text-sm text-slate-500">capacity across {summary.knownAccounts} account{summary.knownAccounts === 1 ? "" : "s"} with available quota data</div>
                </div>
                <div className="grid grid-cols-3 gap-6 text-right">
                  <div>
                    <div className="text-xs text-slate-400">Used</div>
                    <div className="mt-1 text-lg font-semibold text-slate-950">{formatBytes(summary.totalUsedBytes)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-400">Available</div>
                    <div className="mt-1 text-lg font-semibold text-slate-950">{formatBytes(summary.totalFreeBytes)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-400">Usage</div>
                    <div className="mt-1 text-lg font-semibold text-slate-950">{formatPercent(summary.usagePercent)}</div>
                  </div>
                </div>
              </div>

              <div className="mt-6 h-3 overflow-hidden rounded-full bg-slate-100">
                <div className={`h-full rounded-full transition-all ${usageBarClass(summary.usagePercent)}`} style={{ width: `${Math.min(100, Math.max(0, Number(summary.usagePercent) || 0))}%` }} />
              </div>

              <div className="mt-4 flex flex-col gap-2 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between">
                <span>{summary.unavailableAccounts ? `${summary.unavailableAccounts} account quota${summary.unavailableAccounts === 1 ? "" : "s"} unavailable` : "All connected account quotas available"}</span>
                <span>Last successful refresh: {formatDate(summary.lastSuccessfulRefreshAt)}</span>
              </div>
            </section>

            <section className="mt-8">
              <div className="mb-4 flex items-end justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold text-slate-950">Account breakdown</h2>
                  <p className="mt-1 text-sm text-slate-500">Each account remains separate; these values are not a file-type breakdown.</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                <Link
                  to="/admin/storage/health"
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <ShieldCheck size={16} />
                  Storage health
                </Link>
                <Link
                  to="/admin/storage/file-types"
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <BarChart3 size={16} />
                  By file type
                </Link>
                </div>
              </div>

              <div className="space-y-4">
                {accounts.map((account) => (
                  <div key={account.id} className="rounded-2xl border border-slate-200 bg-white p-6">
                    <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                      <div className="flex items-start gap-4">
                        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700"><HardDrive size={20} /></div>
                        <div>
                          <h3 className="font-semibold text-slate-950">{account.email}</h3>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
                            <span className={account.status === "connected" ? "h-2 w-2 rounded-full bg-emerald-500" : "h-2 w-2 rounded-full bg-slate-400"} />
                            <span>{account.status}</span>
                            {account.quotaAvailable && <><span>•</span><span><CheckCircle2 size={13} className="inline" /> quota available</span></>}
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-3 gap-6 text-left lg:text-right">
                        <div>
                          <div className="text-xs text-slate-400">Capacity</div>
                          <div className="mt-1 text-sm font-semibold text-slate-950">{formatBytes(account.limitBytes)}</div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-400">Used</div>
                          <div className="mt-1 text-sm font-semibold text-slate-950">{formatBytes(account.usageBytes)}</div>
                        </div>
                        <div>
                          <div className="text-xs text-slate-400">Free</div>
                          <div className="mt-1 text-sm font-semibold text-slate-950">{formatBytes(account.freeBytes)}</div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-100">
                      <div className={`h-full rounded-full ${usageBarClass(account.usagePercent)}`} style={{ width: `${Math.min(100, Math.max(0, Number(account.usagePercent) || 0))}%` }} />
                    </div>

                    <div className="mt-3 flex flex-col gap-1 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between">
                      <span>{account.quotaAvailable ? `${formatPercent(account.usagePercent)} used` : "Quota unavailable"}</span>
                      <span>Last successful refresh: {formatDate(account.lastSuccessfulRefreshAt)}</span>
                    </div>
                  </div>
                ))}

                {accounts.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
                    No Google Drive accounts are connected.
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default AdminStorage;
