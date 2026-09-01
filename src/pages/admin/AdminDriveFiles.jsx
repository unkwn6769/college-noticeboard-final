import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  FileText,
  FileSpreadsheet,
  FileImage,
  FileArchive,
  HardDrive,
  ExternalLink,
  Search,
  Folder,
  RefreshCw,
} from "lucide-react";
import { API_URL } from "../../config/api";

const PAGE_SIZE = 50;
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";

function formatBytes(value) {
  if (value === null || value === undefined || value === "") return "—";
  const bytes = Number(value);
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes;
  let index = -1;
  do {
    size /= 1024;
    index += 1;
  } while (size >= 1024 && index < units.length - 1);
  return `${size.toFixed(1)} ${units[index]}`;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function getFileExtension(name = "") {
  const cleanName = String(name).split("?")[0];
  const dot = cleanName.lastIndexOf(".");
  return dot > -1 ? cleanName.slice(dot + 1).toLowerCase() : "";
}

function getFileIcon(name = "") {
  const extension = getFileExtension(name);
  if (extension === "pdf") return FileText;
  if (["doc", "docx", "rtf", "txt"].includes(extension)) return FileText;
  if (["xls", "xlsx", "csv"].includes(extension)) return FileSpreadsheet;
  if (["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(extension)) return FileImage;
  if (["zip", "rar", "7z", "tar", "gz"].includes(extension)) return FileArchive;
  return FileText;
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

function decodeCrumbs(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function encodeCrumbs(crumbs) {
  return JSON.stringify(crumbs.map(({ id, name }) => ({ id, name })));
}

function AdminDriveFiles() {
  const { accountId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const folderId = searchParams.get("folderId") || "root";
  const breadcrumbState = useMemo(
    () => decodeCrumbs(searchParams.get("crumbs")),
    [searchParams]
  );

  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [account, setAccount] = useState(null);
  const [items, setItems] = useState([]);
  const [currentFolder, setCurrentFolder] = useState({
    id: "root",
    name: "Drive root",
    parentId: null,
  });
  const [nextPageToken, setNextPageToken] = useState(null);
  const [pageTokens, setPageTokens] = useState([""]);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError("");

        const sessionResponse = await fetch(
          `${API_URL}/api/admin/auth/me`,
          { credentials: "include" }
        );
        if (!sessionResponse.ok) {
          if (!cancelled) setAuthenticated(false);
          return;
        }
        if (!cancelled) setAuthenticated(true);

        const params = new URLSearchParams({
          pageSize: String(PAGE_SIZE),
          folderId,
        });
        const currentPageToken = pageTokens[page - 1] || "";
        if (currentPageToken) params.set("pageToken", currentPageToken);

        const response = await fetch(
          `${API_URL}/api/admin/accounts/${encodeURIComponent(accountId)}/drive-browse?${params.toString()}`,
          { credentials: "include" }
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || "Failed to scan Google Drive folder");
        }

        if (!cancelled) {
          setAccount(data.account || null);
          setItems(data.files || []);
          setCurrentFolder(data.folder || { id: folderId, name: "Drive folder", parentId: null });
          setNextPageToken(data.nextPageToken || null);
        }
      } catch (loadError) {
        if (!cancelled) {
          console.error(loadError);
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to scan Google Drive folder"
          );
          setItems([]);
          setNextPageToken(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    if (accountId) void load();
    return () => {
      cancelled = true;
    };
  }, [accountId, folderId, page, pageTokens]);

  if (loading && !account) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <span className="text-sm text-slate-500">Scanning Google Drive...</span>
      </div>
    );
  }

  if (!authenticated) return <Navigate to="/admin/login" replace />;

  const folders = items.filter((item) => item.isFolder);
  const files = items.filter((item) => !item.isFolder);

  const breadcrumbs = [{ id: "root", name: "Drive root" }, ...breadcrumbState];

  function navigateToFolder(folder) {
    const currentCrumbs = breadcrumbState;
    const nextCrumbs = [
      ...currentCrumbs,
      { id: folder.id, name: folder.name },
    ];
    setPage(1);
    setPageTokens([""]);
    const next = new URLSearchParams();
    next.set("folderId", folder.id);
    next.set("crumbs", encodeCrumbs(nextCrumbs));
    setSearchParams(next);
  }

  function navigateToBreadcrumb(index) {
    if (index === 0) {
      setPage(1);
      setPageTokens([""]);
      setSearchParams(new URLSearchParams({ folderId: "root" }));
      return;
    }
    const target = breadcrumbState[index - 1];
    const nextCrumbs = breadcrumbState.slice(0, index);
    setPage(1);
    setPageTokens([""]);
    const next = new URLSearchParams({
      folderId: target.id,
      crumbs: encodeCrumbs(nextCrumbs),
    });
    setSearchParams(next);
  }

  function goParent() {
    if (!folderId || folderId === "root") return;
    const parentId = currentFolder.parentId || "root";
    const parentIndex = breadcrumbState.findIndex(({ id }) => id === parentId);
    const nextCrumbs = parentIndex >= 0
      ? breadcrumbState.slice(0, parentIndex)
      : [];
    setPage(1);
    setPageTokens([""]);
    const next = new URLSearchParams({ folderId: parentId });
    if (nextCrumbs.length) next.set("crumbs", encodeCrumbs(nextCrumbs));
    setSearchParams(next);
  }

  function goNextPage() {
    if (!nextPageToken) return;
    setPageTokens((tokens) => {
      const next = [...tokens];
      next[page] = nextPageToken;
      return next;
    });
    setPage((value) => value + 1);
  }

  function goPreviousPage() {
    if (page <= 1) return;
    setPage((value) => value - 1);
  }

  function refreshFolder() {
    setPage((value) => value);
    window.dispatchEvent(new Event("drive-folder-refresh"));
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-7xl px-6 py-5">
          <Link
            to="/admin/accounts"
            className="inline-flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-900"
          >
            <ArrowLeft size={16} />
            Google Drive Accounts
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-10">
        <nav className="mb-6 flex items-center gap-1 overflow-x-auto text-sm">
          {breadcrumbs.map((crumb, index) => (
            <div key={crumb.id} className="flex shrink-0 items-center gap-1">
              {index > 0 && <span className="text-slate-300">›</span>}
              {index === breadcrumbs.length - 1 ? (
                <span className="max-w-[260px] truncate font-semibold text-slate-700">
                  {crumb.name}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => navigateToBreadcrumb(index)}
                  className="max-w-[220px] truncate text-slate-400 hover:text-slate-900"
                >
                  {crumb.name}
                </button>
              )}
            </div>
          ))}
        </nav>

        {error && (
          <div className="mb-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {account && (
          <>
            <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Drive Account
                </div>
                <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
                  {account.email}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-500">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="capitalize">{account.status}</span>
                  <span>•</span>
                  <span>Live Google Drive scan</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={goParent}
                  disabled={folderId === "root" || loading}
                  className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  <ChevronLeft size={16} />
                  Parent folder
                </button>
                <button
                  type="button"
                  onClick={refreshFolder}
                  disabled={loading}
                  className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
                  Refresh
                </button>
                <Link
                  to="/admin/file-search"
                  className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <Search size={17} />
                  Search files
                </Link>
              </div>
            </div>

            <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                  <Folder size={17} />
                  {currentFolder.name}
                </div>
                <div className="text-xs text-slate-400">
                  {folders.length + files.length} items on this page
                </div>
              </div>

              {folders.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {folders.map((folder) => (
                    <button
                      key={folder.id}
                      type="button"
                      onClick={() => navigateToFolder(folder)}
                      className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-white hover:text-slate-950"
                    >
                      <Folder size={15} />
                      {folder.name}
                      <ChevronRight size={14} className="text-slate-400" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="hidden grid-cols-[minmax(320px,2fr)_120px_190px_180px] border-b border-slate-200 bg-slate-50 px-5 py-3 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400 sm:grid">
                <div>File</div>
                <div>Size</div>
                <div>Modified</div>
                <div>Actions</div>
              </div>

              {loading ? (
                <div className="p-12 text-center text-sm text-slate-500">
                  Scanning this Google Drive folder…
                </div>
              ) : files.length === 0 && folders.length === 0 ? (
                <div className="p-12 text-center">
                  <HardDrive className="mx-auto text-slate-300" size={34} />
                  <h2 className="mt-4 text-base font-semibold text-slate-950">
                    No files in this folder
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    This view is reading the selected folder directly from Google Drive.
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {files.map((file) => {
                    const FileIcon = getFileIcon(file.name);
                    const departmentSlug = getDepartmentSlug(file.path);
                    const parentPath = getParentPath(file.path);
                    const canOpenPublic = Boolean(departmentSlug && file.path);
                    const publicPath = canOpenPublic
                      ? `/file/${encodeURIComponent(departmentSlug)}?path=${encodeURIComponent(file.path)}&from=${encodeURIComponent(parentPath)}`
                      : null;

                    return (
                      <div
                        key={file.id}
                        className="grid gap-4 px-5 py-4 sm:grid-cols-[minmax(320px,2fr)_120px_190px_180px] sm:items-center"
                      >
                        <div className="flex min-w-0 items-start gap-3">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
                            <FileIcon size={18} />
                          </div>
                          <div className="min-w-0">
                            <div className="break-words text-sm font-semibold leading-5 text-slate-950">
                              {file.name}
                            </div>
                            <div className="mt-1 text-xs leading-5 text-slate-400">
                              {file.managed && file.path
                                ? file.path
                                : file.mimeType || "Google Drive file"}
                            </div>
                            {file.managed && (
                              <span className="mt-2 inline-flex rounded-full bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700">
                                Managed by College Noticeboard
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="text-sm text-slate-600">
                          <div className="text-xs uppercase tracking-wide text-slate-400 sm:hidden">Size</div>
                          {formatBytes(file.sizeBytes)}
                        </div>

                        <div className="text-sm text-slate-600">
                          <div className="text-xs uppercase tracking-wide text-slate-400 sm:hidden">Modified</div>
                          {formatDate(file.sourceModifiedAt)}
                        </div>

                        <div className="flex flex-wrap gap-2">
                          {file.webViewLink && (
                            <a
                              href={file.webViewLink}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                            >
                              <ExternalLink size={12} />
                              Open in Drive
                            </a>
                          )}
                          {publicPath && (
                            <Link
                              to={publicPath}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                            >
                              <ExternalLink size={12} />
                              Public page
                            </Link>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="mt-5 flex items-center justify-between gap-4">
              <div className="text-sm text-slate-500">Page {page}</div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={goPreviousPage}
                  disabled={page <= 1 || loading}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ChevronLeft size={16} />
                  Previous
                </button>
                <button
                  type="button"
                  onClick={goNextPage}
                  disabled={!nextPageToken || loading}
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default AdminDriveFiles;
