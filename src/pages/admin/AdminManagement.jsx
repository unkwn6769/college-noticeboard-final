import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { ArrowLeft, Shield, UserPlus, UserX } from "lucide-react";
import { API_URL } from "../../config/api";

function AdminManagement() {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [role, setRole] = useState(null);
  const [admins, setAdmins] = useState([]);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [newRole, setNewRole] = useState("admin");
  const [saving, setSaving] = useState(false);

  async function load() {
    const sessionResponse = await fetch(
      `${API_URL}/api/admin/auth/me`,
      { credentials: "include" }
    );

    if (!sessionResponse.ok) {
      setAuthenticated(false);
      return;
    }

    const session = await sessionResponse.json();
    if (session.role !== "owner") {
      setAuthenticated(true);
      setRole(session.role);
      return;
    }

    setAuthenticated(true);
    setRole(session.role);

    const response = await fetch(
      `${API_URL}/api/admin/admins`,
      { credentials: "include" }
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Failed to load admin accounts");
    }

    setAdmins(data.admins || []);
  }

  useEffect(() => {
    let cancelled = false;

    load()
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load admin accounts");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  async function addAdmin(event) {
    event.preventDefault();
    setError("");

    try {
      setSaving(true);
      const response = await fetch(`${API_URL}/api/admin/admins`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role: newRole }),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) throw new Error(data.error || "Failed to add admin");

      setAdmins((current) => {
        const without = current.filter((item) => item.id !== data.admin.id);
        return [...without, data.admin].sort((a, b) => {
          if (a.role !== b.role) return a.role === "owner" ? -1 : 1;
          return String(a.createdAt).localeCompare(String(b.createdAt));
        });
      });
      setEmail("");
      setNewRole("admin");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add admin");
    } finally {
      setSaving(false);
    }
  }

  async function updateAdmin(admin, patch) {
    setError("");
    try {
      const response = await fetch(`${API_URL}/api/admin/admins/${encodeURIComponent(admin.id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to update admin");
      setAdmins((current) => current.map((item) => item.id === admin.id ? data.admin : item));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update admin");
    }
  }

  async function removeAdmin(admin) {
    if (!window.confirm(`Remove admin access for ${admin.email}?`)) return;
    setError("");
    try {
      const response = await fetch(`${API_URL}/api/admin/admins/${encodeURIComponent(admin.id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to remove admin");
      setAdmins((current) => current.filter((item) => item.id !== admin.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove admin");
    }
  }

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Loading admin management...</div>;
  }

  if (!authenticated) return <Navigate to="/admin/login" replace />;
  if (role !== "owner") return <Navigate to="/admin" replace />;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center px-6 py-5">
          <Link to="/admin" className="flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-900">
            <ArrowLeft size={16} />
            Admin
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="flex items-end justify-between gap-6">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Security</div>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">Admin Accounts</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">Control who can access the administration panel. Admin access is separate from Google Drive storage accounts.</p>
          </div>
          <Shield className="text-slate-300" size={32} />
        </div>

        {error && <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

        <form onSubmit={addAdmin} className="mt-8 rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex items-center gap-2 text-lg font-semibold text-slate-950"><UserPlus size={19} /> Add admin</div>
          <div className="mt-5 grid gap-4 md:grid-cols-[1fr_180px_auto]">
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="admin@example.com"
              className="rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-slate-400"
              required
            />
            <select value={newRole} onChange={(event) => setNewRole(event.target.value)} className="rounded-xl border border-slate-200 px-4 py-3 text-sm">
              <option value="admin">Admin</option>
              <option value="owner">Owner</option>
            </select>
            <button disabled={saving} className="rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">
              {saving ? "Saving..." : "Add account"}
            </button>
          </div>
          <p className="mt-3 text-xs text-slate-400">The person signs in with the same Google account through the existing admin OAuth flow.</p>
        </form>

        <div className="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-6 py-4 text-sm font-semibold text-slate-950">Authorized administrators</div>
          <div className="divide-y divide-slate-100">
            {admins.map((admin) => (
              <div key={admin.id} className="flex flex-wrap items-center justify-between gap-4 px-6 py-5">
                <div>
                  <div className="font-medium text-slate-950">{admin.email}</div>
                  <div className="mt-1 flex gap-2 text-xs text-slate-400">
                    <span className="capitalize">{admin.role}</span>
                    <span>•</span>
                    <span className="capitalize">{admin.status}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select value={admin.role} onChange={(event) => updateAdmin(admin, { role: event.target.value })} className="rounded-lg border border-slate-200 px-3 py-2 text-xs">
                    <option value="admin">Admin</option>
                    <option value="owner">Owner</option>
                  </select>
                  <button onClick={() => updateAdmin(admin, { status: admin.status === "active" ? "disabled" : "active" })} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
                    {admin.status === "active" ? "Disable" : "Enable"}
                  </button>
                  <button onClick={() => removeAdmin(admin)} className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50">
                    <span className="inline-flex items-center gap-1"><UserX size={13} /> Remove</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}

export default AdminManagement;
