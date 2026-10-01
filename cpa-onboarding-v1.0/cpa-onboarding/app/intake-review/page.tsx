/**
 * Intake review queue: submissions that could not be auto-matched to a booking
 * (no-match / multi-match / submitted before booking). Staff match a submission
 * to a client or waive it. POSTs go to /api/intake/review/[id].
 */
export const dynamic = "force-dynamic";

import { apiGet, type IntakeSubmission } from "../../components/api";

const STATUS_LABELS: Record<string, string> = {
  no_match: "No match",
  multi_match: "Multiple matches",
  pre_booking: "Submitted before booking",
};

export default async function IntakeReviewPage() {
  let submissions: IntakeSubmission[] | null = null;
  try {
    const data = await apiGet<{ submissions: IntakeSubmission[] }>(
      "/api/intake/review",
    );
    submissions = data.submissions ?? [];
  } catch {
    submissions = null;
  }

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold tracking-tight">Intake review</h1>
      <p className="mb-5 text-sm text-slate-500">
        Submissions the auto-matcher could not resolve. Match each to a booked
        client or waive it — every decision is audited.
      </p>

      {submissions === null ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600">
          The intake review API (<code>/api/intake/review</code>) is not
          available yet.
        </div>
      ) : submissions.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          Queue is empty — nothing waiting for review.
        </div>
      ) : (
        <div className="space-y-4">
          {submissions.map((s) => (
            <article
              key={s.id}
              className="rounded-xl border border-slate-200 bg-white p-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                    {STATUS_LABELS[s.match_status ?? ""] ?? s.match_status ?? "Unmatched"}
                  </span>
                  <span className="ml-3 text-sm font-semibold">
                    {s.email ?? "Unknown email"}
                  </span>
                </div>
                {s.received_at && (
                  <span className="text-xs text-slate-400">
                    Received {new Date(s.received_at).toLocaleString()}
                  </span>
                )}
              </div>

              {s.answers && Object.keys(s.answers).length > 0 && (
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer text-slate-600">
                    View answers
                  </summary>
                  <dl className="mt-2 space-y-1 rounded-lg bg-slate-50 p-3">
                    {Object.entries(s.answers).map(([k, v]) => (
                      <div key={k} className="grid grid-cols-3 gap-2">
                        <dt className="font-medium text-slate-500">{k}</dt>
                        <dd className="col-span-2">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}

              <div className="mt-4 flex flex-wrap items-end gap-3">
                {s.candidates && s.candidates.length > 0 ? (
                  <form
                    method="post"
                    action={`/api/intake/review/${encodeURIComponent(String(s.id))}`}
                    className="flex flex-wrap items-end gap-2"
                  >
                    <input type="hidden" name="action" value="match" />
                    <label className="text-xs font-medium text-slate-500">
                      Match to client
                      <select
                        name="client_id"
                        required
                        className="ml-2 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                      >
                        {s.candidates.map((c) => (
                          <option key={c.client_id} value={c.client_id}>
                            {c.name}
                            {c.email ? ` (${c.email})` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="submit"
                      className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-semibold text-white hover:bg-slate-700"
                    >
                      Match
                    </button>
                  </form>
                ) : (
                  <p className="text-sm text-slate-400">
                    No candidate clients proposed.
                  </p>
                )}

                <form
                  method="post"
                  action={`/api/intake/review/${encodeURIComponent(String(s.id))}`}
                  className="flex flex-wrap items-end gap-2"
                >
                  <input type="hidden" name="action" value="waive" />
                  <label className="text-xs font-medium text-slate-500">
                    Waiver reason
                    <input
                      type="text"
                      name="reason"
                      required
                      placeholder="e.g. duplicate submission"
                      className="ml-2 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                    />
                  </label>
                  <button
                    type="submit"
                    className="rounded-lg border border-slate-300 px-4 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Waive
                  </button>
                </form>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
