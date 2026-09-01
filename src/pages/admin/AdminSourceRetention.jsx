import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, RefreshCw, ShieldAlert, Wrench } from "lucide-react";
import { Link, Navigate } from "react-router-dom";
import { API_URL } from "../../config/api";

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let current = bytes;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(current >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

const STATUS_LABELS = {
  pending: "Cleanup pending",
  failed: "Cleanup failed",
  blocked_target_missing: "Target missing",
};

function statusClass(status) {
  if (status === "failed") return "bg-red-50 text-red-700";
  if (status === "blocked_target_missing") return "bg-amber-50 text-amber-700";
  return "bg-slate-100 text-slate-600";
}

function AdminSourceRetention() {
  const [authenticated, setAuthenticated] = useState(false);
  const [adminRole, setAdminRole] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [sourceDeleteStatus, setSourceDeleteStatus] = useState("");
  const [itemStatus, setItemStatus] = useState("");
  const [search, setSearch] = useState("");
  const [draftSearch, setDraftSearch] = useState("");
  const [retrying, setRetrying] = useState(null);

  const load = useCallback(async (signal) => {
    setError("");
    const params = new URLSearchParams({ page: String(page), pageSize: "50" });
    if (sourceDeleteStatus) params.set("sourceDeleteStatus", sourceDeleteStatus);
    if (itemStatus) params.set("itemStatus", itemStatus);
    if (search) params.set("search", search);

    try {
      const response = await fetch(`${API_URL}/api/admin/source-retention?${params}`, {
        credentials: "include",
        signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to load source-retention status");
      setItems(data.items || []);
      setSummary(data.summary || null);
      setPagination(data.pagination || null);
    } catch (err) {
      if (err?.name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Failed to load source-retention status");
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [itemStatus, page, search, sourceDeleteStatus]);

  useEffect(() => {
    const controller = new AbortController();

    async function initialize() {
      try {
        const response = await fetch(`${API_URL}/api/admin/auth/me`, {
          credentials: "include",
          signal: controller.signal,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setAuthenticated(false);
          setLoading(false);
          return;
        }
        setAuthenticated(true);
        setAdminRole(data.role || "");
        await load(controller.signal);
      } catch (err) {
        if (err?.name !== "AbortError") {
          setError("Failed to initialize source-retention view");
          setLoading(false);
        }
      }
    }

    initialize();
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [itemStatus, search, sourceDeleteStatus]);

  function submitSearch(event) {
    event.preventDefault();
    setPage(1);
    setSearch(draftSearch.trim());
  }

  async function refresh() {
    setRefreshing(true);
    await load();
  }

  async function retryCleanup(itemId) {
    if (retrying) return;
    setRetrying(itemId);
    setError("");
    try {
      const response = await fetch(`${API_URL}/api/admin/source-retention/${encodeURIComponent(itemId)}/retry`, {
        method: "POST",
        credentials: "include",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to retry source cleanup");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to retry source cleanup");
    } finally {
      setRetrying(null);
    }
  }

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Loading cleanup status...</div>;
  }

  if (!authenticated) return <Navigate to="/admin/login" replace />;

  const totalPages = Number(pagination?.totalPages || 1);
  const currentPage = Number(pagination?.page || page);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
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

      <main className="mx-auto max-w-7xl px-6 py-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Cleanup</div>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Source Retention</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
              See which migrated sources are still retained, why cleanup has not completed, and which items need operator attention.
            </p>
          </div>
          <ShieldAlert size={30} className="text-slate-300" />
        </div>

        {error && <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {[
            ["Retained sources", summary?.retainedSources ?? 0],
            ["Pending cleanup", summary?.pendingCleanup ?? 0],
            ["Cleanup failed", summary?.cleanupFailed ?? 0],
            ["Target missing", summary?.blockedTargetMissing ?? 0],
            ["Before completion", summary?.retainedBeforeCompletion ?? 0],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</div>
              <div className="mt-2 text-2xl font-bold text-slate-950">{Number(value).toLocaleString()}</div>
            </div>
          ))}
        </div>

        <form onSubmit={submitSearch} className="mt-8 rounded-2xl border border-slate-200 bg-white p-5">
          <div className="grid gap-4 md:grid-cols-4">
            <input
              value={draftSearch}
              onChange={(event) => setDraftSearch(event.target.value)}
              placeholder="Search migration, source/target file ID, or account"
              className="rounded-xl border border-slate-200 px-4 py-3 text-sm text-slate-700 outline-none focus:border-slate-400 md:col-span-2"
            />
            <select value={sourceDeleteStatus} onChange={(event) => setSourceDeleteStatus(event.target.value)} className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 outline-none focus:border-slate-400">
              <option value="">All cleanup states</option>
              <option value="pending">Cleanup pending</option>
              <option value="failed">Cleanup failed</option>
              <option value="blocked_target_missing">Target missing</option>
            </select>
            <select value={itemStatus} onChange={(event) => setItemStatus(event.target.value)} className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 outline-none focus:border-slate-400">
              <option value="">All migration states</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="reconciling">Reconciling</option>
              <option value="reconciliation_expired">Reconciliation expired</option>
              <option value="ambiguous_identity">Ambiguous identity</option>
              <option value="cancelled">Cancelled</option>
              <option value="running">Running</option>
              <option value="pending">Pending</option>
            </select>
          </div>
          <button type="submit" className="mt-4 rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800">Search</button>
        </form>

        <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-6 py-5">
            <div className="text-sm font-semibold text-slate-950">Source-retention records</div>
            <div className="mt-1 text-sm text-slate-400">{Number(pagination?.total || 0).toLocaleString()} retained source records</div>
          </div>

          {items.length === 0 ? (
            <div className="p-14 text-center">
              <Wrench className="mx-auto text-slate-300" size={34} />
              <div className="mt-4 text-sm font-semibold text-slate-700">No retained sources match these filters</div>
              <p className="mt-1 text-sm text-slate-400">Completed cleanup will disappear from this view automatically.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {items.map((item) => (
                <article key={item.id} className="px-6 py-6">
                  <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${statusClass(item.sourceDeleteStatus)}`}>
                          {STATUS_LABELS[item.sourceDeleteStatus] || item.sourceDeleteStatus}
                        </span>
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                          {item.itemStatus}
                        </span>
                      </div>

                      <div className="mt-3 text-sm font-semibold text-slate-950">{item.retentionReason}</div>
                      <div className="mt-1 text-xs text-slate-400">Migration item {item.id}</div>

                      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Source account</div>
                          <div className="mt-1 text-sm text-slate-700">{item.sourceEmail}</div>
                        </div>
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Target account</div>
                          <div className="mt-1 text-sm text-slate-700">{item.targetEmail || "—"}</div>
                        </div>
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Size</div>
                          <div className="mt-1 text-sm text-slate-700">{formatBytes(item.sizeBytes)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Last updated</div>
                          <div className="mt-1 text-sm text-slate-700">{formatDate(item.updatedAt)}</div>
                        </div>
                      </div>

                      {item.sourceDeleteError && (
                        <div className="mt-4 rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-600">{item.sourceDeleteError}</div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 lg:max-w-xs lg:justify-end">
                      {item.sourceDriveUrl && <a href={item.sourceDriveUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"><ExternalLink size={13} /> Source</a>}
                      {item.targetDriveUrl && <a href={item.targetDriveUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"><ExternalLink size={13} /> Target</a>}
                      {adminRole === "owner" && item.itemStatus === "completed" && ["pending", "failed"].includes(item.sourceDeleteStatus) && (
                        <button type="button" onClick={() => retryCleanup(item.id)} disabled={Boolean(retrying)} className="inline-flex items-center gap-1 rounded-xl bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50">
                          <Wrench size={13} />
                          {retrying === item.id ? "Retrying..." : "Retry cleanup"}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-400">
                    <span>Source file: {item.sourceFileId}</span>
                    <span>Attempts: {item.cleanupAttemptCount}</span>
                    <span>Next cleanup: {formatDate(item.cleanupNextAttemptAt)}</span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <div className="mt-5 flex items-center justify-between text-sm text-slate-500">
          <span>Page {currentPage} of {totalPages}</span>
          <div className="flex gap-2">
            <button type="button" disabled={currentPage <= 1} onClick={() => setPage((value) => value - 1)} className="rounded-xl border border-slate-200 bg-white px-4 py-2 font-semibold disabled:opacity-40">Previous</button>
            <button type="button" disabled={currentPage >= totalPages} onClick={() => setPage((value) => value + 1)} className="rounded-xl border border-slate-200 bg-white px-4 py-2 font-semibold disabled:opacity-40">Next</button>
          </div>
        </div>
      </main>
    </div>
  );
}

export default AdminSourceRetention;
