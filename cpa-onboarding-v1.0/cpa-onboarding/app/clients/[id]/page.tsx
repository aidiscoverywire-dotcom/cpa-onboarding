/**
 * Client detail: current state, allowed action buttons (plain POST forms to
 * /api/clients/[id]/actions — the UI never transitions state client-side),
 * transition timeline, "what's missing" document summary, intake answers,
 * and approval status. All data from GET /api/clients/[id].
 */
export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { StateBadge } from "../../../components/StateBadge";
import {
  apiGet,
  type AllowedAction,
  type ClientDetail,
} from "../../../components/api";

function ActionForm({
  clientId,
  action,
}: {
  clientId: string;
  action: AllowedAction;
}) {
  return (
    <form
      method="post"
      action={`/api/clients/${encodeURIComponent(clientId)}/actions`}
      className="inline-block"
    >
      <input type="hidden" name="action" value={action.id} />
      <button
        type="submit"
        className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
      >
        {action.label}
      </button>
    </form>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-slate-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default async function ClientDetailPage({
  params,
}: {
  params: { id: string };
}) {
  let detail: ClientDetail | null = null;
  try {
    const data = await apiGet<{ client: ClientDetail }>(
      `/api/clients/${encodeURIComponent(params.id)}`,
    );
    detail = data.client ?? null;
  } catch {
    detail = null;
  }

  if (!detail) {
    // Distinguish "API not built yet" from "client not found" is impossible
    // without the API — 404 is the honest choice for a missing detail payload.
    notFound();
  }

  const missing = detail.documents?.missing ?? [];
  const required = detail.documents?.required ?? [];
  const answers = detail.intake_answers;
  const transitions = detail.transitions ?? [];
  const actions = detail.allowed_actions ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{detail.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-slate-500">
            {detail.email && <span>{detail.email}</span>}
            {detail.phone && <span>{detail.phone}</span>}
          </div>
          <div className="mt-3">
            <StateBadge state={detail.current_state} stalled={detail.stalled} />
          </div>
          {detail.stalled && (
            <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
              Stalled
              {detail.stalled_since
                ? ` since ${new Date(detail.stalled_since).toLocaleString()}`
                : ""}
              . Any new client activity resumes the pipeline automatically.
            </p>
          )}
        </div>
      </div>

      <Section title="Allowed actions">
        {actions.length === 0 ? (
          <p className="text-sm text-slate-500">
            No actions available in this state.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {actions.map((a) => (
                <ActionForm key={a.id} clientId={detail.id} action={a} />
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-400">
              Actions are executed server-side by the API, which enforces the
              state machine. This page only renders the actions the API allows.
            </p>
          </>
        )}
      </Section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="What's missing — documents">
          {required.length === 0 && missing.length === 0 ? (
            <p className="text-sm text-slate-500">
              No expected-document list for this client yet.
            </p>
          ) : (
            <>
              {missing.length > 0 && (
                <ul className="mb-4 list-disc space-y-1 pl-5 text-sm">
                  {missing.map((m) => (
                    <li key={m} className="font-medium text-red-700">
                      {m}
                    </li>
                  ))}
                </ul>
              )}
              {required.length > 0 && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-400">
                      <th className="py-1">Document</th>
                      <th className="py-1">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {required.map((d) => (
                      <tr key={d.name} className="border-t border-slate-100">
                        <td className="py-1.5">{d.name}</td>
                        <td className="py-1.5">
                          {d.received ? (
                            <span className="text-emerald-700">Received</span>
                          ) : (
                            <span className="text-slate-400">Pending</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="mt-3 text-xs text-slate-400">
                Phase 1: document acceptance is manual — staff confirm receipt;
                nothing is auto-accepted.
              </p>
            </>
          )}
        </Section>

        <Section title="Intake">
          {detail.intake_waiver ? (
            <div className="text-sm">
              <p className="font-semibold text-amber-700">Intake waived</p>
              <p className="mt-1 text-slate-600">
                By {detail.intake_waiver.waived_by ?? "staff"}
                {detail.intake_waiver.at
                  ? ` on ${new Date(detail.intake_waiver.at).toLocaleString()}`
                  : ""}
              </p>
              {detail.intake_waiver.waiver_reason && (
                <p className="mt-1 text-slate-600">
                  Reason: {detail.intake_waiver.waiver_reason}
                </p>
              )}
            </div>
          ) : answers && Object.keys(answers).length > 0 ? (
            <dl className="space-y-2 text-sm">
              {Object.entries(answers).map(([k, v]) => (
                <div key={k} className="grid grid-cols-3 gap-2">
                  <dt className="font-medium text-slate-500">{k}</dt>
                  <dd className="col-span-2">{v}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-slate-500">
              No intake submission received for this client yet.
            </p>
          )}
        </Section>
      </div>

      <Section title="Approval status">
        {!detail.approval ? (
          <p className="text-sm text-slate-500">
            No approval gate pending for this client.
          </p>
        ) : (
          <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            {detail.approval.type && (
              <div>
                <dt className="text-xs text-slate-400">Type</dt>
                <dd className="font-medium">{detail.approval.type}</dd>
              </div>
            )}
            {detail.approval.status && (
              <div>
                <dt className="text-xs text-slate-400">Status</dt>
                <dd className="font-medium">{detail.approval.status}</dd>
              </div>
            )}
            {detail.approval.requested_by && (
              <div>
                <dt className="text-xs text-slate-400">Requested by</dt>
                <dd className="font-medium">{detail.approval.requested_by}</dd>
              </div>
            )}
            {detail.approval.decided_by && (
              <div>
                <dt className="text-xs text-slate-400">Decided by</dt>
                <dd className="font-medium">{detail.approval.decided_by}</dd>
              </div>
            )}
          </dl>
        )}
      </Section>

      <Section title="Transition timeline">
        {transitions.length === 0 ? (
          <p className="text-sm text-slate-500">No transitions recorded.</p>
        ) : (
          <ol className="space-y-3">
            {transitions.map((t, i) => (
              <li key={t.id ?? i} className="flex gap-3 text-sm">
                <span className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full bg-slate-300" />
                <div>
                  <p className="font-medium">
                    {t.from_state ? `${t.from_state} → ` : ""}
                    {t.to_state}
                  </p>
                  <p className="text-xs text-slate-500">
                    {t.at ? new Date(t.at).toLocaleString() : ""}
                    {t.actor ? ` · ${t.actor}` : ""}
                    {t.note ? ` · ${t.note}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}
