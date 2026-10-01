/**
 * Audit log viewer — read-only. Renders GET /api/audit. The underlying
 * `audit_events` table is append-only (DB triggers reject UPDATE/DELETE/
 * TRUNCATE; hash-chained); this page has no mutation affordances at all.
 */
export const dynamic = "force-dynamic";

import Link from "next/link";
import { apiGet, type AuditEvent } from "../../components/api";

export default async function AuditPage() {
  let events: AuditEvent[] | null = null;
  try {
    const data = await apiGet<{ events: AuditEvent[] }>("/api/audit");
    events = data.events ?? [];
  } catch {
    events = null;
  }

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold tracking-tight">Audit log</h1>
      <p className="mb-5 text-sm text-slate-500">
        Append-only record of every staff action and state transition.
        Read-only — entries cannot be edited or deleted from this UI.
      </p>

      {events === null ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600">
          The audit API (<code>/api/audit</code>) is not available yet.
        </div>
      ) : events.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No audit events recorded.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2">Time</th>
                <th className="px-4 py-2">Actor</th>
                <th className="px-4 py-2">Action</th>
                <th className="px-4 py-2">Client</th>
                <th className="px-4 py-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr
                  key={e.id ?? i}
                  className="border-t border-slate-100 align-top"
                >
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-slate-500">
                    {e.at ? new Date(e.at).toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-2">{e.actor ?? "—"}</td>
                  <td className="px-4 py-2 font-mono text-xs">{e.action ?? "—"}</td>
                  <td className="px-4 py-2">
                    {e.client_id ? (
                      <Link
                        href={`/clients/${encodeURIComponent(e.client_id)}`}
                        className="text-sky-700 hover:underline"
                      >
                        {e.client_id}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{e.detail ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
