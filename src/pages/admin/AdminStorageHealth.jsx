import { useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, AlertTriangle, ShieldAlert, RefreshCw } from "lucide-react";
import { Link, Navigate } from "react-router-dom";
import { API_URL } from "../../config/api";

function formatDate(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

const STATUS = {
  healthy: { label: "Healthy", className: "text-emerald-700 bg-emerald-50 border-emerald-200", icon: CheckCircle2 },
  stale: { label: "Stale quota", className: "text-amber-700 bg-amber-50 border-amber-200", icon: AlertTriangle },
  unavailable: { label: "Unavailable", className: "text-red-700 bg-red-50 border-red-200", icon: ShieldAlert },
  authorization_invalid: { label: "Authorization invalid", className: "text-red-700 bg-red-50 border-red-200", icon: ShieldAlert },
  disabled: { label: "Disabled", className: "text-slate-600 bg-slate-100 border-slate-200", icon: ShieldAlert },
};

function AdminStorageHealth() {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState("");

  async function loadHealth(signal) {
    const response = await fetch(`${API_URL}/api/admin/storage/health`, {
      credentials: "include",
      signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Failed to load storage health");
    setHealth(data.health);
  }

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const session = await fetch(`${API_URL}/api/admin/auth/me`, { credentials: "include", signal: controller.signal });
        if (!session.ok) {
          setAuthenticated(false);
          return;
        }
        setAuthenticated(true);
        await loadHealth(controller.signal);
      } catch (err) {
        if (err?.name !== "AbortError") setError(err instanceof Error ? err.message : "Failed to load storage health");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  async function refreshStorage() {
    setRefreshing(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/api/admin/storage/refresh`, {
        method: "POST",
        credentials: "include",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to refresh storage");
      await loadHealth();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh storage");
    } finally {
      setRefreshing(false);
    }
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Loading storage health...</div>;
  if (!authenticated) return <Navigate to="/admin/login" replace />;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Link to="/admin" className="flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-900"><ArrowLeft size={16} />Admin</Link>
          <button type="button" onClick={refreshStorage} disabled={refreshing} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Refreshing..." : "Refresh all quotas"}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Storage</div>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Storage Health</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">Check quota freshness and authorization health for every connected Google Drive account.</p>

        {error && <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

        {health && (
          <>
            <section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[['Healthy', health.healthyAccounts], ['Stale', health.staleAccounts], ['Unavailable', health.unavailableAccounts], ['Auth invalid', health.authorizationInvalidAccounts]].map(([label, value]) => (
                <div key={label} className="rounded-2xl border border-slate-200 bg-white p-5">
                  <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">{label}</div>
                  <div className="mt-2 text-3xl font-bold text-slate-950">{value}</div>
                </div>
              ))}
            </section>

            <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 className="text-xl font-semibold text-slate-950">Account health</h2>
                  <p className="mt-1 text-sm text-slate-500">Last successful refresh: {formatDate(health.lastSuccessfulRefreshAt)}</p>
                </div>
                <Link to="/admin/storage" className="text-sm font-semibold text-slate-600 hover:text-slate-950">View combined storage →</Link>
              </div>

              <div className="mt-6 space-y-3">
                {health.accounts.map((account) => {
                  const config = STATUS[account.health] || STATUS.unavailable;
                  const Icon = config.icon;
                  return (
                    <div key={account.id} className="rounded-2xl border border-slate-200 p-5">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                          <div className="font-semibold text-slate-950">{account.email}</div>
                          <div className="mt-2 text-xs text-slate-400">Last success: {formatDate(account.lastSuccessfulRefreshAt)}{account.snapshotUpdatedAt ? ` • Snapshot updated: ${formatDate(account.snapshotUpdatedAt)}` : ""}</div>
                        </div>
                        <span className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${config.className}`}>
                          <Icon size={14} />{config.label}
                        </span>
                      </div>
                      {account.lastError && (
                        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{account.lastError}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

export default AdminStorageHealth;
