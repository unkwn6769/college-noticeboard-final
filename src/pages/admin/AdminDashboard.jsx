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
