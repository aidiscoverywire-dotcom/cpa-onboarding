/**
 * Pipeline board: the 14 onboarding states as columns, with a stalled overlay
 * badge and a terminal-dispositions section. Renders `current_state` (+ stalled
 * flag) returned by GET /api/clients — the UI never transitions state itself.
 */
export const dynamic = "force-dynamic";

import Link from "next/link";
import { STATES, TERMINAL_DISPOSITIONS, stateLabel } from "../lib/states";
import { StateBadge } from "../components/StateBadge";
import { apiGet, type ClientSummary } from "../components/api";

const TERMINAL_TITLES: Record<string, string> = {
  canceled: "Canceled",
  no_show: "No-show",
  lost: "Lost",
};

function ClientCard({ client }: { client: ClientSummary }) {
  return (
    <Link
      href={`/clients/${client.id}`}
      className="block rounded-lg border border-slate-200 bg-white p-3 shadow-sm hover:border-slate-400"
    >
      <div className="text-sm font-semibold leading-snug">{client.name}</div>
      {client.email && (
        <div className="mt-0.5 truncate text-xs text-slate-500">
          {client.email}
        </div>
      )}
      {client.stalled && (
        <span className="mt-2 inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800">
          Stalled
          {client.stalled_since
            ? ` since ${new Date(client.stalled_since).toLocaleDateString()}`
            : ""}
        </span>
      )}
    </Link>
  );
}

export default async function PipelinePage() {
  let clients: ClientSummary[] | null = null;
  try {
    const data = await apiGet<{ clients: ClientSummary[] }>("/api/clients");
    clients = data.clients ?? [];
  } catch {
    clients = null; // API route not implemented yet — show an honest empty state.
  }

  if (clients === null) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <h1 className="text-xl font-bold">Pipeline</h1>
        <p className="mt-2 text-sm text-slate-600">
          The client list API (<code>/api/clients</code>) is not available yet.
          This board renders once workstream&nbsp;(b) implements it.
        </p>
      </div>
    );
  }

  const byState = new Map<string, ClientSummary[]>();
  for (const c of clients) {
    const list = byState.get(c.current_state) ?? [];
    list.push(c);
    byState.set(c.current_state, list);
  }
  const stalledCount = clients.filter((c) => c.stalled).length;

  return (
    <div>
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="text-xl font-bold tracking-tight">Pipeline</h1>
        <p className="text-sm text-slate-500">
          {clients.length} active · {stalledCount} stalled
        </p>
      </div>

      <div className="board-scroll flex gap-3 overflow-x-auto pb-4">
        {STATES.map((s) => {
          const list = byState.get(s.id) ?? [];
          return (
            <section
              key={s.id}
              className="w-60 shrink-0 rounded-xl bg-slate-200/60 p-2"
            >
              <header className="flex items-center justify-between px-1 pb-2">
                <span className="text-xs font-bold uppercase tracking-wide text-slate-600">
                  <span className="mr-1 font-mono">{s.num}</span>
                  {s.label}
                </span>
                <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-slate-600">
                  {list.length}
                </span>
              </header>
              <div className="space-y-2">
                {list.map((c) => (
                  <ClientCard key={c.id} client={c} />
                ))}
                {list.length === 0 && (
                  <p className="px-1 py-2 text-xs text-slate-400">Empty</p>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <h2 className="mb-3 mt-8 text-lg font-bold tracking-tight">
        Terminal dispositions
      </h2>
      <div className="grid gap-3 md:grid-cols-3">
        {TERMINAL_DISPOSITIONS.map((d) => {
          const list = byState.get(d) ?? [];
          return (
            <section
              key={d}
              className="rounded-xl border border-slate-200 bg-white p-4"
            >
              <header className="mb-3 flex items-center justify-between">
                <span className="text-sm font-bold text-slate-700">
                  {TERMINAL_TITLES[d] ?? stateLabel(d)}
                </span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                  {list.length}
                </span>
              </header>
              <div className="space-y-2">
                {list.map((c) => (
                  <ClientCard key={c.id} client={c} />
                ))}
                {list.length === 0 && (
                  <p className="text-xs text-slate-400">None</p>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <p className="mt-6 text-xs text-slate-400">
        Board badge legend: <StateBadge state="intake_missing" stalled /> — the
        stalled overlay is resumable; terminal dispositions are final.
      </p>
    </div>
  );
}
