import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, BarChart3, FileText, RefreshCw, AlertTriangle, ExternalLink, Search } from "lucide-react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
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

function widthFor(percent) {
  const numeric = Number(percent);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(100, Math.max(0, numeric));
}

function getDepartmentSlug(path = "") {
  const match = String(path).match(/^\/noticeboards\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function getParentPath(path = "") {
  const normalized = String(path).replace(/\/$/, "");
  const slash = normalized.lastIndexOf("/");
  return slash > 0 ? `${normalized.slice(0, slash)}/` : "";
}

export default function AdminStorageFileTypes() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [summary, setSummary] = useState(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [files, setFiles] = useState([]);
  const [filePagination, setFilePagination] = useState(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filePage, setFilePage] = useState(1);
  const [accounts, setAccounts] = useState([]);
  const [filterQuery, setFilterQuery] = useState("");
  const [accountId, setAccountId] = useState("");
  const [status, setStatus] = useState("");
  const [available, setAvailable] = useState("");
  const [filtersApplied, setFiltersApplied] = useState({ q: "", accountId: "", status: "", available: "" });
  const selectedKey = searchParams.get("type");

  const load = useCallback(async (signal) => {
    setError("");
    try {
      const response = await fetch(`${API_URL}/api/admin/storage/file-types`, {
        credentials: "include",
        signal,
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 || response.status === 403) {
        setAuthenticated(false);
        return;
      }
      if (!response.ok) throw new Error(data.error || "Failed to load storage usage by file type");
      setAuthenticated(true);
      setSummary(data.summary);
    } catch (err) {
      if (err?.name !== "AbortError") {
        console.error(err);
        setError(err instanceof Error ? err.message : "Failed to load storage usage by file type");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    let cancelled = false;

    fetch(`${API_URL}/api/admin/accounts`, { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json().catch(() => ({}));
        if (!cancelled) setAccounts(data.accounts || []);
      })
      .catch((err) => {
        if (!cancelled) console.error("Failed to load Drive account filters:", err);
      });

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setFilePage(1);
    setFilterQuery("");
    setAccountId("");
    setStatus("");
    setAvailable("");
    setFiltersApplied({ q: "", accountId: "", status: "", available: "" });
  }, [selectedKey]);

  useEffect(() => {
    if (!selectedKey) {
      setFiles([]);
      setFilePagination(null);
      return undefined;
    }

    const controller = new AbortController();
    setFilesLoading(true);

    const params = new URLSearchParams({
      page: String(filePage),
      pageSize: "50",
      fileType: selectedKey,
    });
    if (filtersApplied.q) params.set("q", filtersApplied.q);
    if (filtersApplied.accountId) params.set("accountId", filtersApplied.accountId);
    if (filtersApplied.status) params.set("status", filtersApplied.status);
    if (filtersApplied.available) params.set("available", filtersApplied.available);

    fetch(`${API_URL}/api/admin/drive-files?${params.toString()}`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || "Failed to load files for this type");
        }
        setFiles(data.files || []);
        setFilePagination(data.pagination || null);
      })
      .catch((err) => {
        if (err?.name !== "AbortError") {
          setError(err instanceof Error ? err.message : "Failed to load files for this type");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setFilesLoading(false);
      });

    return () => controller.abort();
  }, [selectedKey, filePage, filtersApplied]);

  async function refresh() {
    setRefreshing(true);
    const controller = new AbortController();
    try {
      await load(controller.signal);
    } finally {
      controller.abort();
      setRefreshing(false);
    }
  }

  const groups = summary?.groups || [];
  const selectedGroup = groups.find((group) => group.key === selectedKey) || null;
  const visibleGroups = selectedGroup ? [selectedGroup] : groups;
  const totalBytes = BigInt(summary?.totalBytes || "0");
  const totalFileCount = summary?.totalFiles || 0;
  const knownSizeFiles = summary?.knownSizeFiles || 0;
  const unknownSizeFiles = summary?.unknownSizeFiles || 0;

  const largestGroup = useMemo(() => groups[0] || null, [groups]);

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Loading file-type storage...</div>;
  }

  if (!authenticated) return <Navigate to="/admin/login" replace />;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Link to="/admin/storage" className="flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-900">
            <ArrowLeft size={16} />
            Storage
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
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Storage</div>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Storage Usage by File Type</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
            Storage used by managed Google Drive files, grouped by the file types actually present in your connected Drives. Folders are excluded. Click a category to see the individual files behind it.
          </p>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {selectedGroup ? (
            <>
              <div className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700">
                Showing: {selectedGroup.label}
              </div>
              <button
                type="button"
                onClick={() => setSearchParams({})}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-500 hover:bg-slate-50 hover:text-slate-900"
              >
                Show all types
              </button>
            </>
          ) : (
            <div className="text-sm text-slate-400">Select a category below to see the actual files in that type.</div>
          )}
        </div>

        <Link
          to="/admin/file-search"
          className="mt-5 flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
        >
          <div>
            <div className="text-sm font-semibold text-slate-950">Drive File Search / Filter</div>
            <div className="mt-1 text-sm text-slate-500">Search the full managed Drive inventory by filename, account, file type, status, or availability.</div>
          </div>
          <span className="shrink-0 text-sm font-semibold text-slate-600">Open search →</span>
        </Link>

        {error && <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

        {summary && (
          <>
            {unknownSizeFiles > 0 && (
              <div className="mt-6 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                <AlertTriangle size={18} className="mt-0.5 shrink-0" />
                <div>
                  {unknownSizeFiles.toLocaleString()} file{unknownSizeFiles === 1 ? " has" : "s have"} no stored size, so the byte total covers {knownSizeFiles.toLocaleString()} of {totalFileCount.toLocaleString()} files.
                </div>
              </div>
            )}

            <section className="mt-8 grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 bg-white p-6">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Managed storage</div>
                <div className="mt-2 text-3xl font-bold text-slate-950">{formatBytes(totalBytes.toString())}</div>
                <div className="mt-1 text-sm text-slate-500">{knownSizeFiles.toLocaleString()} files with known size</div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-6">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">File count</div>
                <div className="mt-2 text-3xl font-bold text-slate-950">{totalFileCount.toLocaleString()}</div>
                <div className="mt-1 text-sm text-slate-500">Synced Google Drive files</div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-6">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Largest category</div>
                <div className="mt-2 text-3xl font-bold text-slate-950">{largestGroup?.label || "—"}</div>
                <div className="mt-1 text-sm text-slate-500">{largestGroup ? `${formatPercent(largestGroup.percent)} of known-size bytes` : "No data"}</div>
              </div>
            </section>

            <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-700">
                  <BarChart3 size={20} />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-slate-950">Usage breakdown</h2>
                  <p className="mt-1 text-sm text-slate-500">Categories are sorted by storage consumed.</p>
                </div>
              </div>

              <div className="mt-8 space-y-6">
                {visibleGroups.map((group) => (
                  <button
                    key={group.key}
                    type="button"
                    onClick={() => setSearchParams({ type: group.key })}
                    className={`group block w-full rounded-2xl p-3 text-left transition ${selectedKey === group.key ? "bg-slate-50 ring-1 ring-slate-300" : "hover:bg-slate-50"}`}
                    aria-label={`Focus on ${group.label} storage usage`}
                  >
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                      <div className="flex items-center gap-3">
                        <FileText size={18} className="text-slate-400" />
                        <div>
                          <div className="font-semibold text-slate-950">{group.label}</div>
                          <div className="text-xs text-slate-400">
                            {group.fileCount.toLocaleString()} files{group.extensions.length ? ` · ${group.extensions.slice(0, 8).join(", ")}${group.extensions.length > 8 ? ", …" : ""}` : ""}
                            {group.unknownSizeCount ? ` · ${group.unknownSizeCount.toLocaleString()} unknown size` : ""}
                          </div>
                        </div>
                      </div>
                      <div className="text-left sm:text-right">
                        <div className="font-semibold text-slate-950">{formatBytes(group.sizeBytes)}</div>
                        <div className="text-xs text-slate-400">{formatPercent(group.percent)}</div>
                      </div>
                    </div>
                    <div className="mt-3 h-3 overflow-hidden rounded-full bg-slate-100">
                      <div className="h-full rounded-full bg-slate-900 transition-all" style={{ width: `${widthFor(group.percent)}%` }} />
                    </div>
                    <div className="mt-2 text-xs font-medium text-slate-400 opacity-0 transition group-hover:opacity-100">
                      Click to view actual files in this category
                    </div>
                  </button>
                ))}

                {groups.length === 0 && (
                  <div className="rounded-2xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">
                    No synced Google Drive files are available for analysis.
                  </div>
                )}
              </div>
            </section>

            {selectedGroup && (
              <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Actual files</div>
                    <h2 className="mt-2 text-xl font-semibold text-slate-950">{selectedGroup.label} files in your connected Drives</h2>
                    <p className="mt-1 text-sm text-slate-500">These are the individual managed Drive files behind this category, not just an aggregate type label.</p>
                  </div>
                  {filePagination && (
                    <div className="text-sm text-slate-500">{filePagination.total.toLocaleString()} files</div>
                  )}
                </div>

                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    setFilePage(1);
                    setFiltersApplied({
                      q: filterQuery.trim(),
                      accountId,
                      status,
                      available,
                    });
                  }}
                  className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-950">Search & filter {selectedGroup.label} files</div>
                      <div className="mt-1 text-xs text-slate-500">File type is locked to {selectedGroup.label}; narrow this category by filename, Drive account, storage status, or availability.</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setFilterQuery("");
                        setAccountId("");
                        setStatus("");
                        setAvailable("");
                        setFiltersApplied({ q: "", accountId: "", status: "", available: "" });
                        setFilePage(1);
                      }}
                      className="shrink-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                    >
                      Clear filters
                    </button>
                  </div>

                  <div className="mt-4 flex flex-col gap-3 lg:flex-row">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
                      <input
                        value={filterQuery}
                        onChange={(event) => setFilterQuery(event.target.value)}
                        placeholder={`Search ${selectedGroup.label.toLowerCase()} filename, path, or Drive file ID`}
                        className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-900 outline-none focus:border-slate-400"
                      />
                    </div>
                    <button
                      type="submit"
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
                    >
                      <Search size={15} />
                      Apply filters
                    </button>
                  </div>

                  <div className="mt-3 grid gap-3 md:grid-cols-3">
                    <label className="text-sm text-slate-600">
                      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">Account</span>
                      <select
                        value={accountId}
                        onChange={(event) => setAccountId(event.target.value)}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 outline-none focus:border-slate-400"
                      >
                        <option value="">All connected accounts</option>
                        {accounts.map((account) => (
                          <option key={account.id} value={account.id}>{account.email}</option>
                        ))}
                      </select>
                    </label>

                    <label className="text-sm text-slate-600">
                      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">Storage status</span>
                      <select
                        value={status}
                        onChange={(event) => setStatus(event.target.value)}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 outline-none focus:border-slate-400"
                      >
                        <option value="">All statuses</option>
                        <option value="synced">Synced</option>
                        <option value="pending">Pending</option>
                        <option value="uploading">Uploading</option>
                        <option value="failed">Failed</option>
                      </select>
                    </label>

                    <label className="text-sm text-slate-600">
                      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">Availability</span>
                      <select
                        value={available}
                        onChange={(event) => setAvailable(event.target.value)}
                        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 outline-none focus:border-slate-400"
                      >
                        <option value="">All files</option>
                        <option value="available">Available</option>
                        <option value="unavailable">Unavailable</option>
                      </select>
                    </label>
                  </div>
                </form>

                {filesLoading ? (
                  <div className="mt-8 rounded-2xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">Loading actual Drive files...</div>
                ) : files.length === 0 ? (
                  <div className="mt-8 rounded-2xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500">No files found in this category.</div>
                ) : (
                  <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200">
                    <div className="hidden grid-cols-[minmax(300px,2fr)_180px_120px_160px] border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400 sm:grid">
                      <div>File</div><div>Drive account</div><div>Size</div><div>Modified</div>
                    </div>
                    <div className="divide-y divide-slate-100">
                      {files.map((file) => (
                        <div key={`${file.fileId}-${file.id}`} className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(300px,2fr)_180px_120px_160px] sm:items-center">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <FileText size={17} className="shrink-0 text-slate-400" />
                              <div className="break-words text-sm font-semibold text-slate-950">{file.name}</div>
                              <a
                                href={`https://drive.google.com/file/d/${encodeURIComponent(file.fileId)}/view`}
                                target="_blank"
                                rel="noreferrer"
                                aria-label={`Open ${file.name} in Google Drive`}
                                className="shrink-0 text-slate-400 hover:text-slate-900"
                              >
                                <ExternalLink size={14} />
                              </a>
                              <Link
                                to={`/admin/file-search?q=${encodeURIComponent(file.fileId)}&accountId=${encodeURIComponent(file.accountId)}`}
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                              >
                                <Search size={12} />
                                Find in search
                              </Link>
                              {getDepartmentSlug(file.path) && (
                                <Link
                                  to={`/file/${encodeURIComponent(getDepartmentSlug(file.path))}?path=${encodeURIComponent(file.path)}&from=${encodeURIComponent(getParentPath(file.path))}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                                >
                                  <ExternalLink size={12} />
                                  Public page
                                </Link>
                              )}
                            </div>
                            <div className="mt-1 break-all text-xs text-slate-400">{file.path || file.fileId}</div>
                          </div>
                          <div className="text-sm text-slate-600">
                            <div className="text-xs uppercase tracking-wide text-slate-400 sm:hidden">Drive account</div>
                            {file.accountEmail}
                          </div>
                          <div className="text-sm text-slate-600">
                            <div className="text-xs uppercase tracking-wide text-slate-400 sm:hidden">Size</div>
                            {formatBytes(file.sizeBytes)}
                          </div>
                          <div className="text-sm text-slate-600">
                            <div className="text-xs uppercase tracking-wide text-slate-400 sm:hidden">Modified</div>
                            {file.sourceModifiedAt ? new Date(file.sourceModifiedAt).toLocaleString() : "—"}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {filePagination && filePagination.totalPages > 1 && (
                  <div className="mt-5 flex items-center justify-between gap-4">
                    <div className="text-sm text-slate-500">Page {filePagination.page} of {filePagination.totalPages}</div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setFilePage((current) => Math.max(1, current - 1))}
                        disabled={filePagination.page <= 1}
                        className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50"
                      >Previous</button>
                      <button
                        type="button"
                        onClick={() => setFilePage((current) => Math.min(filePagination.totalPages, current + 1))}
                        disabled={filePagination.page >= filePagination.totalPages}
                        className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50"
                      >Next</button>
                    </div>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
