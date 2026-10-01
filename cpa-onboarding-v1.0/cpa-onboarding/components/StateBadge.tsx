import { stateLabel, stateNum } from "../lib/states";

const STATE_TONES: Record<string, string> = {
  booked: "bg-sky-100 text-sky-800",
  intake_missing: "bg-amber-100 text-amber-800",
  intake_received: "bg-emerald-100 text-emerald-800",
  brief_ready: "bg-teal-100 text-teal-800",
  meeting_done: "bg-indigo-100 text-indigo-800",
  discount_applied: "bg-violet-100 text-violet-800",
  scope_changed: "bg-orange-100 text-orange-800",
  docusign_sent: "bg-blue-100 text-blue-800",
  docusign_signed: "bg-green-100 text-green-800",
  dropbox_request_ready: "bg-cyan-100 text-cyan-800",
  organizer_sent: "bg-cyan-100 text-cyan-800",
  docs_partial: "bg-yellow-100 text-yellow-800",
  docs_complete: "bg-lime-100 text-lime-800",
  onboarded: "bg-slate-800 text-white",
};

export function StateBadge({
  state,
  stalled,
}: {
  state: string;
  stalled?: boolean;
}) {
  const tone = STATE_TONES[state] ?? "bg-slate-200 text-slate-700";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}
      >
        <span className="mr-1 font-mono opacity-70">{stateNum(state)}</span>
        {stateLabel(state)}
      </span>
      {stalled && (
        <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-800">
          Stalled
        </span>
      )}
    </span>
  );
}
