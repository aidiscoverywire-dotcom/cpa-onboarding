/**
 * Settings: firm-configurable stall thresholds (GET /api/settings) and the
 * current signed-in staff member's identity/role (decoded from the session).
 * Read-only display — threshold changes are a workstream-(b) API concern.
 */
export const dynamic = "force-dynamic";

import { apiGet, getCurrentUser, type Settings } from "../../components/api";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  let settings: Settings | null = null;
  try {
    settings = await apiGet<Settings>("/api/settings");
  } catch {
    settings = null;
  }
  const thresholds = settings?.stall_thresholds ?? {};

  return (
    <div className="max-w-3xl">
      <h1 className="mb-5 text-xl font-bold tracking-tight">Settings</h1>

      <section className="mb-5 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">
          Signed in as
        </h2>
        {!user ? (
          <p className="text-sm text-slate-500">No active session.</p>
        ) : (
          <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div>
              <dt className="text-xs text-slate-400">Name</dt>
              <dd className="font-medium">{user.name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Email</dt>
              <dd className="font-medium">{user.email ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Role</dt>
              <dd>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                  {user.role}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-slate-400">Google sub</dt>
              <dd className="font-mono text-xs">{user.sub}</dd>
            </div>
          </dl>
        )}
        <p className="mt-3 text-xs text-slate-400">
          Sessions are keyed on the Google subject (`sub`) and carry the staff
          role. Idle sessions expire after 8 hours of inactivity; all sessions
          expire 12 hours after sign-in.
        </p>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">
          Stall thresholds
        </h2>
        {settings === null ? (
          <p className="text-sm text-slate-500">
            The settings API (<code>/api/settings</code>) is not available yet.
          </p>
        ) : Object.keys(thresholds).length === 0 ? (
          <p className="text-sm text-slate-500">
            No stall thresholds configured. Defaults apply.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400">
                <th className="py-1">Rule</th>
                <th className="py-1">Threshold</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(thresholds).map(([k, v]) => (
                <tr key={k} className="border-t border-slate-100">
                  <td className="py-1.5 font-medium">{k}</td>
                  <td className="py-1.5">{String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-xs text-slate-400">
          Stall detection alerts are internal-only in Phase 1 — staff are
          notified, clients are never messaged automatically.
        </p>
      </section>
    </div>
  );
}
