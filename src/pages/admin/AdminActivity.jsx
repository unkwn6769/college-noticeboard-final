import { useCallback, useEffect, useState } from "react";
import { Activity, ArrowLeft, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { Link, Navigate } from "react-router-dom";
import { API_URL } from "../../config/api";

const FILTERS = [
  ["", "All activity"],
  ["admin.login", "Admin login"],
  ["admin.logout", "Admin logout"],
  ["drive_account.connected", "Drive account connected"],
  ["drive_account.enabled", "Drive account enabled"],
  ["drive_account.disabled", "Drive account disabled"],
  ["drive_account.removed", "Drive account removed"],
  ["storage.refreshed", "Storage refreshed"],
  ["drive_file.restored", "Drive file restored"],
  ["drive_file.permanently_deleted", "Drive file permanently deleted"],
  ["migration.created", "Migration created"],
  ["migration.cancel_requested", "Migration cancellation"],
  ["admin.created", "Admin created"],
  ["admin.updated", "Admin updated"],
  ["admin.removed", "Admin removed"],
];

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function typeLabel(eventType) {
  return eventType
    .split(".")
    .map((part) => part.replace(/_/g, " "))
    .join(" / ");
}

function AdminActivity() {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [entries, setEntries] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [eventType, setEventType] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (requestedPage = page, signal) => {
    setError("");
    try {
      const params = new URLSearchParams({ page: String(requestedPage), pageSize: "50" });
      if (eventType) params.set("eventType", eventType);

      const response = await fetch(`${API_URL}/api/admin/activity?${params}`, {
        credentials: "include",
        signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to load activity log");

      setEntries(data.entries || []);
      setPagination(data.pagination || null);
    } catch (err) {
      if (err?.name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Failed to load activity log");
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [eventType, page]);

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
        await load(page, controller.signal);
      } catch (err) {
        if (err?.name !== "AbortError") {
          setError("Failed to initialize activity log");
          setLoading(false);
        }
      }
    }

    initialize();
    return () => controller.abort();
  }, [load, page]);

  useEffect(() => {
    setPage(1);
  }, [eventType]);

  async function refresh() {
    setRefreshing(true);
    await load(page);
  }

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Loading activity log...</div>;
  }

  if (!authenticated) return <Navigate to="/admin/login" replace />;

  const canPrevious = Number(pagination?.page || 1) > 1;
  const canNext = Number(pagination?.page || 1) < Number(pagination?.totalPages || 1);

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
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Audit</div>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Activity Log</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">A chronological record of important administrator actions across Drive accounts, storage refreshes, migrations, and admin access.</p>
          </div>
          <Activity size={30} className="text-slate-300" />
        </div>

        {error && <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <select
            value={eventType}
            onChange={(event) => setEventType(event.target.value)}
            className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 outline-none focus:border-slate-400"
          >
            {FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <div className="text-sm text-slate-400">{Number(pagination?.total || 0).toLocaleString()} total events</div>
        </div>

        <section className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {entries.length === 0 ? (
            <div className="p-14 text-center">
              <Activity className="mx-auto text-slate-300" size={34} />
              <div className="mt-4 text-sm font-semibold text-slate-700">No activity recorded yet</div>
              <p className="mt-1 text-sm text-slate-400">Important admin actions will appear here as they happen.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {entries.map((entry) => (
                <article key={entry.id} className="px-6 py-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{typeLabel(entry.eventType)}</span>
                        {entry.actorEmail && <span className="text-xs text-slate-400">by {entry.actorEmail}</span>}
                      </div>
                      <p className="mt-3 text-sm font-medium text-slate-950">{entry.description}</p>
                      {entry.entityType && entry.entityId && (
                        <div className="mt-1 text-xs text-slate-400">{entry.entityType}: {entry.entityId}</div>
                      )}
                    </div>
                    <time className="shrink-0 text-xs text-slate-400">{formatDate(entry.createdAt)}</time>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <div className="mt-5 flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3">
          <span className="text-xs text-slate-400">Page {pagination?.page || 1} of {pagination?.totalPages || 1}</span>
          <div className="flex items-center gap-2">
            <button disabled={!canPrevious} onClick={() => setPage((value) => value - 1)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"><ChevronLeft size={14} /> Previous</button>
            <button disabled={!canNext} onClick={() => setPage((value) => value + 1)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40">Next <ChevronRight size={14} /></button>
          </div>
        </div>
      </main>
    </div>
  );
}

export default AdminActivity;
