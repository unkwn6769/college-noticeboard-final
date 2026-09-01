import { useEffect, useState } from "react";
import { Navigate, Link } from "react-router-dom";
import { API_URL } from "../../config/api";

function AdminDashboard() {
  const [loading, setLoading] = useState(true);
  const [admin, setAdmin] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const response = await fetch(
          `${API_URL}/api/admin/auth/me`,
          {
            credentials: "include",
          }
        );

        if (response.ok) {
          const data = await response.json();

          if (!cancelled) {
            setAdmin(data);
          }
        }
      } catch (error) {
        console.error("Admin session load failed:", error);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadSession();

    return () => {
      cancelled = true;
    };
  }, []);

  async function logout() {
    try {
      await fetch(
        `${API_URL}/api/admin/auth/logout`,
        {
          method: "POST",
          credentials: "include",
        }
      );
    } finally {
      window.location.href = "/admin/login";
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-sm text-slate-500">
          Loading admin...
        </div>
      </div>
    );
  }

  if (!admin) {
    return <Navigate to="/admin/login" replace />;
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              Admin
            </div>
            <h1 className="text-xl font-bold text-slate-950">
              College Noticeboard
            </h1>
          </div>

          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-500">
              {admin.email}
            </span>

            <button
              onClick={logout}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Log out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <h2 className="text-2xl font-bold text-slate-950">
          Administration
        </h2>

        <p className="mt-2 text-sm text-slate-500">
          Manage Google Drive storage accounts and manual
          synchronization.
        </p>

        <div className="mt-8 grid gap-5 md:grid-cols-2">
          <Link
            to="/admin/accounts"
            className="rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-slate-300 hover:shadow-sm"
          >
            <h3 className="text-lg font-semibold text-slate-950">
              Google Drive Accounts
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              View connected storage accounts, quotas, and
              connection status.
            </p>
          </Link>

          <Link
            to="/admin/storage"
            className="group rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-slate-300 hover:shadow-sm"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">
                  Combined Storage
                </h3>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  View total capacity, usage, available space, and the per-account breakdown.
                </p>
              </div>
              <span className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500" aria-hidden="true">→</span>
            </div>
          </Link>

          <Link
            to="/admin/storage/health"
            className="group rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-slate-300 hover:shadow-sm"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">Storage Health</h3>
                <p className="mt-2 text-sm leading-6 text-slate-500">Check quota freshness, refresh all connected Drives, and spot authorization or availability problems.</p>
              </div>
              <span className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500" aria-hidden="true">→</span>
            </div>
          </Link>

          <Link
            to="/admin/file-search"
            className="group rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-slate-300 hover:shadow-sm"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">
                  Drive File Search
                </h3>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  Search and filter the managed Google Drive file inventory by name, account, type, status, or availability.
                </p>
              </div>
              <span className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500" aria-hidden="true">→</span>
            </div>
          </Link>

          <Link
            to="/admin/storage/file-types"
            className="group rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-slate-300 hover:shadow-sm"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">
                  Storage by File Type
                </h3>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  See which file types consume the most storage across all connected Drives.
                </p>
              </div>
              <span className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500" aria-hidden="true">→</span>
            </div>
          </Link>

          <Link
            to="/admin/source-retention"
            className="group rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-slate-300 hover:shadow-sm"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">Source Retention</h3>
                <p className="mt-2 text-sm leading-6 text-slate-500">See retained migration sources, cleanup failures, blocked targets, and safe owner-only cleanup retries.</p>
              </div>
              <span className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500" aria-hidden="true">→</span>
            </div>
          </Link>

          <Link
            to="/admin/recycle-bin"
            className="group rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-slate-300 hover:shadow-sm"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">Recycle Bin</h3>
                <p className="mt-2 text-sm leading-6 text-slate-500">View managed Google Drive files in trash, restore them, or permanently delete them.</p>
              </div>
              <span className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500" aria-hidden="true">→</span>
            </div>
          </Link>

          <Link
            to="/admin/activity"
            className="group rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-slate-300 hover:shadow-sm"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">Activity Log</h3>
                <p className="mt-2 text-sm leading-6 text-slate-500">Review important admin, Drive account, storage, and migration actions.</p>
              </div>
              <span className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500" aria-hidden="true">→</span>
            </div>
          </Link>

          {admin.role === "owner" && (
            <Link
              to="/admin/admins"
              className="rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-slate-300 hover:shadow-sm"
            >
              <h3 className="text-lg font-semibold text-slate-950">
                Admin Accounts
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                Add, disable, promote, or remove administrators.
              </p>
            </Link>
          )}

          <Link
            to="/"
            className="group rounded-2xl border border-slate-200 bg-white p-6 transition hover:border-slate-300 hover:shadow-sm"
            target="_blank"
            rel="noreferrer"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">
                  Public Website
                </h3>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  Open the public College Noticeboard and verify the pages students see.
                </p>
              </div>
              <span className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500" aria-hidden="true">↗</span>
            </div>
          </Link>

          <div className="rounded-2xl border border-slate-200 bg-white p-6">
            <h3 className="text-lg font-semibold text-slate-950">
              Manual Sync
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              This section will control manual crawler runs.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

export default AdminDashboard;
