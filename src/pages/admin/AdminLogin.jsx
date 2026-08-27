import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { API_URL } from "../../config/api";

function AdminLogin() {
  const [checking, setChecking] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function checkSession() {
      try {
        const response = await fetch(
          `${API_URL}/api/admin/auth/me`,
          {
            credentials: "include",
          }
        );

        if (!cancelled) {
          setAuthenticated(response.ok);
        }
      } catch (error) {
        console.error("Admin session check failed:", error);
      } finally {
        if (!cancelled) {
          setChecking(false);
        }
      }
    }

    checkSession();

    return () => {
      cancelled = true;
    };
  }, []);

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-sm text-slate-500">
          Checking admin session...
        </div>
      </div>
    );
  }

  if (authenticated) {
    return <Navigate to="/admin" replace />;
  }

  const loginUrl =
    `${API_URL}/api/admin/auth/google`;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-8">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
            Admin
          </div>

          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
            College Noticeboard
          </h1>

          <p className="mt-3 text-sm leading-6 text-slate-500">
            Sign in with your authorized Google account to manage
            storage and synchronization.
          </p>
        </div>

        <a
          href={loginUrl}
          className="flex w-full items-center justify-center gap-3 rounded-2xl bg-slate-950 px-5 py-3.5 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          Continue with Google
        </a>

        <p className="mt-6 text-center text-xs text-slate-400">
          Unauthorized Google accounts will be rejected.
        </p>
      </div>
    </div>
  );
}

export default AdminLogin;
