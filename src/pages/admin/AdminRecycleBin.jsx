import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { Link, Navigate } from "react-router-dom";
import { API_URL } from "../../config/api";

function formatBytes(value) {
  if (value === null || value === undefined || value === "") return "—";
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 2)} ${units[exponent]}`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function AdminRecycleBin() {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [admin, setAdmin] = useState(null);
  const [files, setFiles] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [busyFile, setBusyFile] = useState("");

  const load = useCallback(async (signal) => {
    const params = new URLSearchParams();
    if (accountId) params.set("accountId", accountId);
    const response = await fetch(`${API_URL}/api/admin/recycle-bin${params.toString() ? `?${params}` : ""}`, {
      credentials: "include",
      signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Failed to load recycle bin");
    setFiles(data.files || []);
  }, [accountId]);

  useEffect(() => {
    const controller = new AbortController();
    async function initialize() {
      try {
        const me = await fetch(`${API_URL}/api/admin/auth/me`, { credentials: "include", signal: controller.signal });
        if (!me.ok) {
          setAuthenticated(false);
          return;
        }
        const meData = await me.json();
        setAdmin(meData);
        setAuthenticated(true);
        const accountResponse = await fetch(`${API_URL}/api/admin/accounts`, { credentials: "include", signal: controller.signal });
        const accountData = await accountResponse.json().catch(() => ({}));
        if (accountResponse.ok) setAccounts(accountData.accounts || []);
        await load(controller.signal);
      } catch (err) {
        if (err?.name !== "AbortError") setError(err instanceof Error ? err.message : "Failed to load recycle bin");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    initialize();
    return () => controller.abort();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    setError("");
    try {
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh recycle bin");
    } finally {
      setRefreshing(false);
    }
  }

  async function restore(file) {
    setBusyFile(file.fileId);
    setError("");
    try {
      const response = await fetch(`${API_URL}/api/admin/recycle-bin/${encodeURIComponent(file.fileId)}/restore`, {
        method: "POST",
        credentials: "include",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to restore file");
      setFiles((current) => current.filter((item) => item.fileId !== file.fileId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to restore file");
    } finally {
      setBusyFile("");
    }
  }

  async function permanentlyDelete(file) {
    const confirmed = window.confirm(`Permanently delete “${file.name}” from Google Drive? This cannot be undone.`);
    if (!confirmed) return;
    setBusyFile(file.fileId);
    setError("");
    try {
      const response = await fetch(`${API_URL}/api/admin/recycle-bin/${encodeURIComponent(file.fileId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to permanently delete file");
      setFiles((current) => current.filter((item) => item.fileId !== file.fileId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to permanently delete file");
    } finally {
      setBusyFile("");
    }
  }

  if (loading) return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Loading recycle bin...</div>;
  if (!authenticated) return <Navigate to="/admin/login" replace />;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <Link to="/admin" className="flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-900">
            <ArrowLeft size={16} /> Admin
          </Link>
          <button type="button" onClick={refresh} disabled={refreshing} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} /> {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Storage</div>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Recycle Bin</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">Managed Google Drive files currently in trash. Restore returns a file to Drive; permanent deletion cannot be undone.</p>
          </div>
          <Trash2 size={30} className="text-slate-300" />
        </div>

        {error && <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

        <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)} className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
            <option value="">All connected accounts</option>
            {accounts.filter((account) => account.status === "connected").map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}
          </select>
          <div className="text-sm text-slate-400">{files.length.toLocaleString()} trashed managed files</div>
        </div>

        <section className="mt-5 space-y-3">
          {files.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-14 text-center">
              <Trash2 className="mx-auto text-slate-300" size={36} />
              <div className="mt-4 text-sm font-semibold text-slate-700">Recycle bin is empty</div>
              <p className="mt-1 text-sm text-slate-400">No managed files are currently in Google Drive trash.</p>
            </div>
          ) : files.map((file) => (
            <article key={file.fileId} className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <h2 className="truncate font-semibold text-slate-950">{file.name}</h2>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">
                    <span>{file.accountEmail}</span><span>{file.mimeType}</span><span>{formatBytes(file.sizeBytes)}</span><span>Trashed {formatDate(file.modifiedTime)}</span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <a href={file.webViewLink} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"><ExternalLink size={14} /> Open in Drive</a>
                  <button type="button" onClick={() => restore(file)} disabled={busyFile === file.fileId} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"><RotateCcw size={14} /> Restore</button>
                  {admin?.role === "owner" && <button type="button" onClick={() => permanentlyDelete(file)} disabled={busyFile === file.fileId} className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"><Trash2 size={14} /> Delete permanently</button>}
                </div>
              </div>
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}

export default AdminRecycleBin;
