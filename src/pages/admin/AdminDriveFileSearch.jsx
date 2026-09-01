import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, ExternalLink, Search, SlidersHorizontal, X } from "lucide-react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { API_URL } from "../../config/api";

const PAGE_SIZE = 50;

const FILE_TYPES = [
  ["", "All file types"],
  ["pdf", "PDF"],
  ["documents", "Documents"],
  ["spreadsheets", "Spreadsheets"],
  ["presentations", "Presentations"],
  ["images", "Images"],
  ["video", "Video"],
  ["audio", "Audio"],
  ["archives", "Archives"],
  ["code", "Code"],
  ["text", "Text"],
  ["other", "Other / unknown"],
  ["no_extension", "No extension"],
];

function formatBytes(value) {
  if (value === null || value === undefined || value === "") return "—";
  try {
    const bytes = BigInt(value);
    if (bytes < 1024n) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB", "PB"];
    let unit = -1;
    let current = bytes;
    while (current >= 1024n && unit < units.length - 1) {
      current /= 1024n;
      unit += 1;
    }
    const size = Number(bytes) / 1024 ** (unit + 1);
    return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
  } catch {
    return "—";
  }
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function getParentPath(path = "") {
  const normalized = String(path).replace(/\/$/, "");
  const slash = normalized.lastIndexOf("/");
  return slash > 0 ? `${normalized.slice(0, slash)}/` : "";
}

function getDepartmentSlug(path = "") {
  const match = String(path).match(/^\/noticeboards\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

function AdminDriveFileSearch() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q") || "";
  const accountId = searchParams.get("accountId") || "";
  const fileType = searchParams.get("fileType") || "";
  const status = searchParams.get("status") || "";
  const available = searchParams.get("available") || "";
  const page = Math.max(1, Number(searchParams.get("page") || 1));

  const [draftQuery, setDraftQuery] = useState(query);
  const [accounts, setAccounts] = useState([]);
  const [files, setFiles] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setDraftQuery(query);
  }, [query]);

  useEffect(() => {
    let cancelled = false;

    async function loadAccounts() {
      try {
        const response = await fetch(`${API_URL}/api/admin/accounts`, { credentials: "include" });
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled) setAccounts(data.accounts || []);
      } catch (loadError) {
        console.error("Drive account filter load failed:", loadError);
      }
    }

    void loadAccounts();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError("");

        const sessionResponse = await fetch(`${API_URL}/api/admin/auth/me`, {
          credentials: "include",
        });

        if (!sessionResponse.ok) {
          if (!cancelled) setAuthenticated(false);
          return;
        }

        if (!cancelled) setAuthenticated(true);

        const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
        if (query) params.set("q", query);
        if (accountId) params.set("accountId", accountId);
        if (fileType) params.set("fileType", fileType);
        if (status) params.set("status", status);
        if (available) params.set("available", available);

        const response = await fetch(`${API_URL}/api/admin/drive-files?${params.toString()}`, {
          credentials: "include",
        });
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(data.error || "Failed to search Google Drive files");
        }

        if (!cancelled) {
          setFiles(data.files || []);
          setPagination(data.pagination || null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to search Google Drive files");
          setFiles([]);
          setPagination(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [query, accountId, fileType, status, available, page]);

  const totalPages = pagination?.totalPages || 1;
  const total = pagination?.total || 0;
  const hasFilters = Boolean(query || accountId || fileType || status || available);

  const selectedAccountEmail = useMemo(
    () => accounts.find((account) => account.id === accountId)?.email || "",
    [accounts, accountId]
  );

  function updateFilters(next) {
    const nextParams = new URLSearchParams(searchParams);
    Object.entries(next).forEach(([key, value]) => {
      if (value) nextParams.set(key, value);
      else nextParams.delete(key);
    });
    nextParams.set("page", "1");
    setSearchParams(nextParams);
  }

  function submitSearch(event) {
    event.preventDefault();
    updateFilters({ q: draftQuery.trim() });
  }

  function clearFilters() {
    setDraftQuery("");
    setSearchParams({ page: "1" });
  }

  if (!authenticated && !loading) {
    return <Navigate to="/admin/login" replace />;
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-7xl px-6 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Link to="/admin" className="inline-flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-900">
              <ArrowLeft size={16} />
              Administration
            </Link>
            <Link to="/admin/accounts" className="text-sm font-semibold text-slate-600 hover:text-slate-950">
              Google Drive Accounts
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-10">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Drive</div>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Search & Filter Files</h1>
          <p className="mt-2 text-sm text-slate-500">Search the managed Google Drive inventory without loading all 47k+ files into the browser.</p>
        </div>

        <div className="mt-7 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <form onSubmit={submitSearch} className="flex flex-col gap-3 lg:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
              <input
                value={draftQuery}
                onChange={(event) => setDraftQuery(event.target.value)}
                placeholder="Search filename, path, or Drive file ID"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 py-3 pl-11 pr-4 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:bg-white"
              />
            </div>
            <button type="submit" className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800">
              <Search size={16} /> Search
            </button>
          </form>

          <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <label className="text-sm text-slate-600">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">Account</span>
              <select
                value={accountId}
                onChange={(event) => updateFilters({ accountId: event.target.value })}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 outline-none focus:border-slate-400"
              >
                <option value="">All connected accounts</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>{account.email}</option>
                ))}
              </select>
            </label>

            <label className="text-sm text-slate-600">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">File type</span>
              <select value={fileType} onChange={(event) => updateFilters({ fileType: event.target.value })} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 outline-none focus:border-slate-400">
                {FILE_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>

            <label className="text-sm text-slate-600">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">Storage status</span>
              <select value={status} onChange={(event) => updateFilters({ status: event.target.value })} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 outline-none focus:border-slate-400">
                <option value="">All statuses</option>
                <option value="synced">Synced</option>
                <option value="pending">Pending</option>
                <option value="uploading">Uploading</option>
                <option value="failed">Failed</option>
              </select>
            </label>

            <label className="text-sm text-slate-600">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">Availability</span>
              <select value={available} onChange={(event) => updateFilters({ available: event.target.value })} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-3 outline-none focus:border-slate-400">
                <option value="">All files</option>
                <option value="available">Available</option>
                <option value="unavailable">Unavailable</option>
              </select>
            </label>
          </div>

          {hasFilters && (
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <SlidersHorizontal size={14} />
              <span>Active filters:</span>
              {query && <span className="rounded-full bg-slate-100 px-3 py-1">Search: {query}</span>}
              {selectedAccountEmail && <span className="rounded-full bg-slate-100 px-3 py-1">Account: {selectedAccountEmail}</span>}
              {fileType && <span className="rounded-full bg-slate-100 px-3 py-1">Type: {FILE_TYPES.find(([key]) => key === fileType)?.[1] || fileType}</span>}
              {status && <span className="rounded-full bg-slate-100 px-3 py-1">Status: {status}</span>}
              {available && <span className="rounded-full bg-slate-100 px-3 py-1">{available}</span>}
              <button type="button" onClick={clearFilters} className="inline-flex items-center gap-1 font-semibold text-slate-700 hover:text-slate-950">
                <X size={13} /> Clear all
              </button>
            </div>
          )}
        </div>

        <div className="mt-6 rounded-2xl border border-slate-200 bg-white overflow-hidden">
          <div className="flex flex-col gap-2 border-b border-slate-200 bg-slate-50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-950">Search results</div>
              <div className="text-xs text-slate-500">{loading ? "Searching…" : `${total.toLocaleString()} matching managed files`}</div>
            </div>
          </div>

          {error ? (
            <div className="p-10 text-center text-sm text-red-700">{error}</div>
          ) : loading ? (
            <div className="p-10 text-center text-sm text-slate-500">Searching managed Drive files…</div>
          ) : files.length === 0 ? (
            <div className="p-12 text-center">
              <Search className="mx-auto text-slate-300" size={34} />
              <h2 className="mt-4 text-base font-semibold text-slate-950">No matching files</h2>
              <p className="mt-1 text-sm text-slate-500">Try a different filename, account, type, or status filter.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {files.map((file) => {
                const departmentSlug = getDepartmentSlug(file.path);
                const parentPath = getParentPath(file.path);
                const publicPath = departmentSlug && file.path
                  ? `/file/${encodeURIComponent(departmentSlug)}?path=${encodeURIComponent(file.path)}&from=${encodeURIComponent(parentPath)}`
                  : null;

                return (
                  <div key={`${file.fileId}-${file.accountId}`} className="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(320px,2fr)_220px_110px_180px] lg:items-center">
                    <div className="min-w-0">
                      <div className="break-words text-sm font-semibold text-slate-950">{file.name}</div>
                      <div className="mt-1 break-all text-xs text-slate-400">{file.path || file.fileId}</div>
                      {publicPath && (
                        <Link to={publicPath} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-slate-600 hover:text-slate-950">
                          <ExternalLink size={13} /> Public page
                        </Link>
                      )}
                    </div>
                    <div className="text-sm text-slate-600">
                      <div className="text-xs uppercase tracking-wide text-slate-400 lg:hidden">Drive account</div>
                      {file.accountEmail}
                    </div>
                    <div className="text-sm text-slate-600">
                      <div className="text-xs uppercase tracking-wide text-slate-400 lg:hidden">Size</div>
                      {formatBytes(file.sizeBytes)}
                    </div>
                    <div className="text-sm text-slate-600">
                      <div className="text-xs uppercase tracking-wide text-slate-400 lg:hidden">Modified</div>
                      {formatDate(file.sourceModifiedAt)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between gap-4">
          <div className="text-sm text-slate-500">Page {pagination?.page || page} of {totalPages}</div>
          <div className="flex items-center gap-2">
            <button type="button" disabled={page <= 1 || loading} onClick={() => updateFilters({ page: String(Math.max(1, page - 1)) })} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">
              <ChevronLeft size={16} /> Previous
            </button>
            <button type="button" disabled={page >= totalPages || loading} onClick={() => updateFilters({ page: String(Math.min(totalPages, page + 1)) })} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">
              Next <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

export default AdminDriveFileSearch;
