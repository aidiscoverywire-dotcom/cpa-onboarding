/**
 * Single source of truth for the onboarding pipeline states.
 * Binding per build brief §3. Owned by the coordinator — workstreams import read-only.
 */

export const STATES = [
  { id: "booked", num: "01", label: "Booked" },
  { id: "intake_missing", num: "02", label: "Intake missing" },
  { id: "intake_received", num: "03", label: "Intake received" },
  { id: "brief_ready", num: "04", label: "Brief ready" },
  { id: "meeting_done", num: "05", label: "Meeting done" },
  { id: "discount_applied", num: "06", label: "Discount applied" },
  { id: "scope_changed", num: "07", label: "Scope changed" },
  { id: "docusign_sent", num: "08", label: "DocuSign sent" },
  { id: "docusign_signed", num: "09", label: "DocuSign signed" },
  { id: "dropbox_request_ready", num: "10", label: "Dropbox request ready" },
  { id: "organizer_sent", num: "11", label: "Organizer sent" },
  { id: "docs_partial", num: "12", label: "Docs partial" },
  { id: "docs_complete", num: "13", label: "Docs complete" },
  { id: "onboarded", num: "14", label: "Onboarded" },
] as const;

export type StateId = (typeof STATES[number])["id"];

export const STATE_IDS: readonly StateId[] = STATES.map((s) => s.id);

export function stateLabel(id: string): string {
  return STATES.find((s) => s.id === id)?.label ?? id;
}

export function stateNum(id: string): string {
  return STATES.find((s) => s.id === id)?.num ?? "?";
}

/** Resumable overlay — a client can be stalled in any non-terminal state. */
export const OVERLAY_STALLED = "stalled" as const;

/** Terminal dispositions for prospects who disappear. */
export const TERMINAL_DISPOSITIONS = ["canceled", "no_show", "lost"] as const;
export type TerminalDisposition = (typeof TERMINAL_DISPOSITIONS)[number];

export function isValidState(id: string): id is StateId {
  return (STATE_IDS as readonly string[]).includes(id);
}
