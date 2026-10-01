/**
 * Owner approval gates (e.g. DocuSign send, organizer command). Named
 * approvers approve or reject; POSTs go to /api/approvals/[id] with
 * { decision: "approve" | "reject", note? }.
 */
export const dynamic = "force-dynamic";

import Link from "next/link";
import { apiGet, type Approval } from "../../components/api";

const TYPE_LABELS: Record<string, string> = {
  docusign_send: "DocuSign send",
  organizer_command: "Organizer command",
};

export default async function ApprovalsPage() {
  let approvals: Approval[] | null = null;
  try {
    const data = await apiGet<{ approvals: Approval[] }>("/api/approvals");
    approvals = data.approvals ?? [];
  } catch {
    approvals = null;
  }

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold tracking-tight">Approvals</h1>
      <p className="mb-5 text-sm text-slate-500">
        Owner approval gates. Nothing client-facing is sent without an explicit
        approval here — drafts and commands stay internal until approved.
      </p>

      {approvals === null ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600">
          The approvals API (<code>/api/approvals</code>) is not available yet.
        </div>
      ) : approvals.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No pending approvals.
        </div>
      ) : (
        <div className="space-y-4">
          {approvals.map((a) => (
            <article
              key={a.id}
              className="rounded-xl border border-slate-200 bg-white p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-semibold text-indigo-800">
                    {TYPE_LABELS[a.type ?? ""] ?? a.type ?? "Approval"}
                  </span>
                  {a.client_name ? (
                    <Link
                      href={`/clients/${encodeURIComponent(a.client_id ?? "")}`}
                      className="text-sm font-semibold hover:underline"
                    >
                      {a.client_name}
                    </Link>
                  ) : (
                    a.client_id && (
                      <span className="text-sm font-semibold">{a.client_id}</span>
                    )
                  )}
                </div>
                <span className="text-xs text-slate-400">
                  {a.requested_by ? `Requested by ${a.requested_by}` : ""}
                  {a.requested_at
                    ? ` · ${new Date(a.requested_at).toLocaleString()}`
                    : ""}
                </span>
              </div>

              {a.detail && (
                <p className="mt-3 text-sm text-slate-600">{a.detail}</p>
              )}

              <form
                method="post"
                action={`/api/approvals/${encodeURIComponent(String(a.id))}`}
                className="mt-4 flex flex-wrap items-end gap-2"
              >
                <label className="text-xs font-medium text-slate-500">
                  Note (optional)
                  <input
                    type="text"
                    name="note"
                    placeholder="Decision note"
                    className="ml-2 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                  />
                </label>
                <button
                  type="submit"
                  name="decision"
                  value="approve"
                  className="rounded-lg bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600"
                >
                  Approve
                </button>
                <button
                  type="submit"
                  name="decision"
                  value="reject"
                  className="rounded-lg border border-red-200 px-4 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50"
                >
                  Reject
                </button>
              </form>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
