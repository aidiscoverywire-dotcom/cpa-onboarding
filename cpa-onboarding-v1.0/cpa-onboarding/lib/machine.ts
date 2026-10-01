/**
 * XState v5 state machine for the CPA client-onboarding pipeline.
 *
 * SERVER-SIDE ONLY. Never import from client components: the browser renders
 * `current_state` + `allowed_actions` from the API and never transitions.
 *
 * Binding per BUILD_BRIEF §3 — 14 states (ids from `lib/states.ts`):
 *   01 booked → 02 intake_missing → 03 intake_received → 04 brief_ready →
 *   05 meeting_done → 06 discount_applied → 07 scope_changed →
 *   08 docusign_sent → 09 docusign_signed → 10 dropbox_request_ready →
 *   11 organizer_sent → 12 docs_partial → 13 docs_complete → 14 onboarded
 *
 * Overlays:
 *   - `stalled`: reachable from any non-terminal state (01–13); the source
 *     state id is stored in `context.resumeState` and CLIENT_ACTIVITY resumes
 *     exactly there. Re-detecting while stalled is a no-op (throws).
 *   - Terminal dispositions `canceled` / `no_show` / `lost`: reachable from
 *     the early (pre-signature) states 01–07 and from `stalled`, so Calendly
 *     canceled/no-show events never leave prospects stuck in 02 or Stalled.
 *
 * Signature-first is structural: no event in the transition table requests
 * documents before state 09 (docusign_signed). DROPBOX_READY exists only as
 * 09→10, and DOCS_UPDATED only from 10/11/12/13.
 *
 * The single source of truth is the ACTIONS registry below: the machine's
 * transitions, the role guards, `allowedActions()` (UI), and the blocker
 * messages in `transition()` are all derived from it.
 */

import { and, assign, createActor, createMachine } from "xstate";
import {
  OVERLAY_STALLED,
  STATE_IDS,
  TERMINAL_DISPOSITIONS,
  type StateId,
  type TerminalDisposition,
} from "./states";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type Role =
  | "owner"
  | "admin"
  | "partner"
  | "staff"
  | "viewer"
  | "webhook"
  | "system";

/** Any persisted client position: a pipeline state, the stalled overlay, or a terminal disposition. */
export type PersistedState = StateId | typeof OVERLAY_STALLED | TerminalDisposition;

export interface ActorRef {
  /** users.id, or "webhook:calendly" / "webhook:docusign" / "webhook:typeform" / "job:stall-check". */
  id: string;
  type: "user" | "webhook" | "system";
  role: Role;
}

export interface CpaContext {
  clientId: string;
  /** Current engagement scope version; SCOPE_CHANGED increments it. */
  scopeVersion: number;
  /** Policy version the client's engagement order was created under. */
  policyVersion: string;
  /**
   * Scope version the owner last approved for sending. DOCUSIGN_SENT requires
   * this to equal `scopeVersion` — SCOPE_CHANGED clears it, which is the
   * binding "named owner approval gate before every send".
   */
  ownerApprovalForScopeVersion: number | null;
  /** State to resume when leaving the stalled overlay. */
  resumeState: StateId | null;
  docsRequired: number;
  docsReceived: number;
  stalledAt: string | null;
  stalledReason: string | null;
  /** Set by SCOPE_CHANGED 08→07: the unsigned envelope must be voided. */
  voidUnsignedEnvelope: boolean;
  /** Set by SCOPE_CHANGED 09–13→07: the signed envelope is superseded by amendment. */
  supersedeSignedEnvelope: boolean;
}

export function baseContext(clientId: string): CpaContext {
  return {
    clientId,
    scopeVersion: 1,
    policyVersion: "v1",
    ownerApprovalForScopeVersion: null,
    resumeState: null,
    docsRequired: 0,
    docsReceived: 0,
    stalledAt: null,
    stalledReason: null,
    voidUnsignedEnvelope: false,
    supersedeSignedEnvelope: false,
  };
}

export type MachineEvent =
  | { type: "BOOKING_CREATED"; actor: ActorRef }
  | { type: "INTAKE_REQUESTED"; actor: ActorRef }
  | { type: "INTAKE_MATCHED"; actor: ActorRef; submissionId: string }
  | { type: "INTAKE_WAIVED"; actor: ActorRef; waiverId: string; reason: string }
  | { type: "BRIEF_APPROVED"; actor: ActorRef }
  | { type: "MEETING_DONE"; actor: ActorRef }
  | { type: "APPLY_DISCOUNT"; actor: ActorRef; discountPct: number }
  | { type: "SCOPE_CHANGED"; actor: ActorRef }
  | { type: "DOCUSIGN_SENT"; actor: ActorRef; envelopeId: string }
  | { type: "DOCUSIGN_SIGNED"; actor: ActorRef }
  | { type: "DROPBOX_READY"; actor: ActorRef; fileRequestId?: string }
  | { type: "ORGANIZER_SENT"; actor: ActorRef }
  | { type: "DOCS_UPDATED"; actor: ActorRef; docsRequired: number; docsReceived: number }
  | { type: "ONBOARDED"; actor: ActorRef }
  | { type: "STALL_DETECTED"; actor: ActorRef; reason: string }
  | { type: "CLIENT_ACTIVITY"; actor: ActorRef; activity: string }
  | { type: "MARK_CANCELED"; actor: ActorRef; reason?: string }
  | { type: "MARK_NO_SHOW"; actor: ActorRef }
  | { type: "MARK_LOST"; actor: ActorRef; reason?: string };

export type EventType = MachineEvent["type"];

/* ------------------------------------------------------------------ */
/* Action registry — single source of truth                             */
/* ------------------------------------------------------------------ */

const STAFF: Role[] = ["owner", "admin", "partner", "staff"];
const AUTOMATION: Role[] = ["webhook", "system"];

/** Pre-signature states: the only pipeline states a prospect can be terminated from. */
export const EARLY_STATES: StateId[] = [
  "booked",
  "intake_missing",
  "intake_received",
  "brief_ready",
  "meeting_done",
  "discount_applied",
  "scope_changed",
];

/** Non-terminal pipeline states — the only states STALL_DETECTED may fire from. */
const STALLABLE_STATES: StateId[] = (STATE_IDS as StateId[]).filter(
  (s) => s !== "onboarded",
);

export interface ActionDef {
  event: EventType;
  label: string;
  description: string;
  from: PersistedState[];
  roles: Role[];
  /** DOCUSIGN_SENT: additionally requires owner approval for the current scope version. */
  requiresOwnerApproval?: boolean;
}

export const ACTIONS: ActionDef[] = [
  {
    event: "BOOKING_CREATED",
    label: "Booking created",
    description: "Calendly invitee.created — new prospect, or re-booking after a terminal disposition.",
    from: ["booked", "canceled", "no_show", "lost"],
    roles: [...AUTOMATION, ...STAFF],
  },
  {
    event: "INTAKE_REQUESTED",
    label: "Intake requested",
    description: "No intake submission matched the new booking — client now awaits intake (01→02).",
    from: ["booked"],
    roles: [...AUTOMATION, ...STAFF],
  },
  {
    event: "INTAKE_MATCHED",
    label: "Intake matched",
    description: "Typeform submission matched to this booking by normalized email (02→03).",
    from: ["intake_missing"],
    roles: [...AUTOMATION, ...STAFF],
  },
  {
    event: "INTAKE_WAIVED",
    label: "Waive intake",
    description: "Staff override skipping the intake form — audited, owner/admin only (02→04).",
    from: ["intake_missing"],
    roles: ["owner", "admin"],
  },
  {
    event: "BRIEF_APPROVED",
    label: "Approve brief",
    description: "Named approver signs off the templated research brief (03→04).",
    from: ["intake_received"],
    roles: [...STAFF],
  },
  {
    event: "MEETING_DONE",
    label: "Meeting done",
    description: "Intro meeting completed (04→05).",
    from: ["brief_ready"],
    roles: [...STAFF],
  },
  {
    event: "APPLY_DISCOUNT",
    label: "Apply discount",
    description: "Commercial discount recorded — owner/partner only (05→06). Discount lives in state 06 + transition/audit history; there is no discount_status column.",
    from: ["meeting_done"],
    roles: ["owner", "partner"],
  },
  {
    event: "SCOPE_CHANGED",
    label: "Change scope",
    description: "Scope revision: bumps the scope version, clears owner approval, flags unsigned envelopes for voiding and signed envelopes for supersession by amendment. From 08–13 returns the client to 07.",
    from: [
      "meeting_done",
      "discount_applied",
      "scope_changed",
      "docusign_sent",
      "docusign_signed",
      "dropbox_request_ready",
      "organizer_sent",
      "docs_partial",
      "docs_complete",
    ],
    roles: [...STAFF],
  },
  {
    event: "DOCUSIGN_SENT",
    label: "Send engagement letter",
    description: "Send the DocuSign engagement-letter envelope. Requires recorded owner approval for the CURRENT scope version (commercial bypasses 05→08, 06→08, 07→08).",
    from: ["meeting_done", "discount_applied", "scope_changed"],
    roles: [...STAFF],
    requiresOwnerApproval: true,
  },
  {
    event: "DOCUSIGN_SIGNED",
    label: "Engagement signed",
    description: "DocuSign Connect completion webhook (08→09).",
    from: ["docusign_sent"],
    roles: [...AUTOMATION],
  },
  {
    event: "DROPBOX_READY",
    label: "Dropbox request ready",
    description: "Per-client/per-year Dropbox file request created — only after signature (09→10).",
    from: ["docusign_signed"],
    roles: [...AUTOMATION, ...STAFF],
  },
  {
    event: "ORGANIZER_SENT",
    label: "Organizer sent",
    description: "Tax organizer dispatched through the settled upload surface (10→11). Partial failure keeps the client at 10 and only the organizer step is retried.",
    from: ["dropbox_request_ready"],
    roles: [...AUTOMATION, ...STAFF],
  },
  {
    event: "DOCS_UPDATED",
    label: "Documents updated",
    description: "Checklist counts changed — target auto-derives: docs_complete when received >= required, else docs_partial.",
    from: ["dropbox_request_ready", "organizer_sent", "docs_partial", "docs_complete"],
    roles: [...AUTOMATION, ...STAFF],
  },
  {
    event: "ONBOARDED",
    label: "Mark onboarded",
    description: "Manual staff acceptance — client is fully onboarded (13→14).",
    from: ["docs_complete"],
    roles: [...STAFF],
  },
  {
    event: "STALL_DETECTED",
    label: "Mark stalled",
    description: "Stall-check job (or staff) flags an idle client. Stores the current state as resumeState.",
    from: STALLABLE_STATES,
    roles: ["system", ...STAFF],
  },
  {
    event: "CLIENT_ACTIVITY",
    label: "Resume from stalled",
    description: "Client activity (intake submission, file upload) resumes the stored state.",
    from: [OVERLAY_STALLED],
    roles: [...AUTOMATION, ...STAFF, "viewer"],
  },
  {
    event: "MARK_CANCELED",
    label: "Mark canceled",
    description: "Calendly canceled event or staff action — terminal disposition.",
    from: [...EARLY_STATES, OVERLAY_STALLED],
    roles: [...AUTOMATION, ...STAFF],
  },
  {
    event: "MARK_NO_SHOW",
    label: "Mark no-show",
    description: "Calendly no_show event or staff action — terminal disposition.",
    from: [...EARLY_STATES, OVERLAY_STALLED],
    roles: [...AUTOMATION, ...STAFF],
  },
  {
    event: "MARK_LOST",
    label: "Mark lost",
    description: "Prospect lost — terminal disposition.",
    from: [...EARLY_STATES, OVERLAY_STALLED],
    roles: [...STAFF],
  },
];

const ACTION_BY_EVENT = new Map<EventType, ActionDef>(
  ACTIONS.map((a) => [a.event, a]),
);

/* ------------------------------------------------------------------ */
/* Machine construction (generated from ACTIONS)                        */
/* ------------------------------------------------------------------ */

type OnMap = Record<string, unknown>;

function roleGuard(roles: Role[]): (args: any) => boolean {
  // `any` params keep this combinable with XState's `and()` alongside the
  // inline guards below; the event shape is enforced at the transition()
  // boundary instead.
  return ({ event }: any) => roles.includes(event?.actor?.role);
}

/** States whose SCOPE_CHANGED implies a signed envelope exists (→ supersede by amendment). */
const SIGNED_BEFORE_STATES: StateId[] = [
  "docusign_signed",
  "dropbox_request_ready",
  "organizer_sent",
  "docs_partial",
  "docs_complete",
];

function buildStates(): Record<string, { on: OnMap }> {
  const states: Record<string, { on: OnMap }> = {};
  // Every state node must exist, even if nothing transitions FROM it
  // (e.g. `onboarded` is only ever a target).
  const allIds: string[] = [
    ...(STATE_IDS as readonly string[]),
    OVERLAY_STALLED,
    ...TERMINAL_DISPOSITIONS,
  ];
  for (const id of allIds) states[id] = { on: {} };
  const ensure = (id: string) => (states[id] ??= { on: {} });

  const add = (from: string, event: EventType, t: unknown) => {
    const on = ensure(from).on;
    const existing = on[event];
    if (existing === undefined) {
      on[event] = t;
    } else if (Array.isArray(existing)) {
      existing.push(t);
    } else {
      on[event] = [existing, t];
    }
  };

  for (const def of ACTIONS) {
    for (const from of def.from) {
      switch (def.event) {
        case "BOOKING_CREATED":
          add(from, def.event, {
            target: "booked",
            guard: roleGuard(def.roles),
          });
          break;

        case "INTAKE_REQUESTED":
          add(from, def.event, {
            target: "intake_missing",
            guard: roleGuard(def.roles),
          });
          break;

        case "INTAKE_MATCHED":
          add(from, def.event, {
            target: "intake_received",
            guard: roleGuard(def.roles),
          });
          break;

        case "INTAKE_WAIVED":
          add(from, def.event, {
            target: "brief_ready",
            guard: roleGuard(def.roles),
          });
          break;

        case "BRIEF_APPROVED":
          add(from, def.event, {
            target: "brief_ready",
            guard: roleGuard(def.roles),
          });
          break;

        case "MEETING_DONE":
          add(from, def.event, {
            target: "meeting_done",
            guard: roleGuard(def.roles),
          });
          break;

        case "APPLY_DISCOUNT":
          add(from, def.event, {
            target: "discount_applied",
            guard: roleGuard(def.roles),
          });
          break;

        case "SCOPE_CHANGED":
          add(from, def.event, {
            target: "scope_changed",
            guard: roleGuard(def.roles),
            actions: assign({
              scopeVersion: ({ context }) => context.scopeVersion + 1,
              // Approval was for the old version — must be re-recorded.
              ownerApprovalForScopeVersion: () => null,
              voidUnsignedEnvelope: () => from === "docusign_sent",
              supersedeSignedEnvelope: () =>
                SIGNED_BEFORE_STATES.includes(from as StateId),
            }),
          });
          break;

        case "DOCUSIGN_SENT":
          add(from, def.event, {
            target: "docusign_sent",
            guard: and([
              roleGuard(def.roles),
              ({ context }: any) =>
                context.ownerApprovalForScopeVersion === context.scopeVersion,
            ]),
            actions: assign({
              voidUnsignedEnvelope: () => false,
              supersedeSignedEnvelope: () => false,
            }),
          });
          break;

        case "DOCUSIGN_SIGNED":
          add(from, def.event, {
            target: "docusign_signed",
            guard: roleGuard(def.roles),
          });
          break;

        case "DROPBOX_READY":
          add(from, def.event, {
            target: "dropbox_request_ready",
            guard: roleGuard(def.roles),
          });
          break;

        case "ORGANIZER_SENT":
          add(from, def.event, {
            target: "organizer_sent",
            guard: roleGuard(def.roles),
          });
          break;

        case "DOCS_UPDATED":
          add(from, def.event, [
            {
              target: "docs_complete",
              guard: and([
                roleGuard(def.roles),
                ({ event }: any) =>
                  event.type === "DOCS_UPDATED" &&
                  event.docsRequired > 0 &&
                  event.docsReceived >= event.docsRequired,
              ]),
              actions: assign({
                docsRequired: ({ event }: { event: MachineEvent }) =>
                  event.type === "DOCS_UPDATED" ? event.docsRequired : 0,
                docsReceived: ({ event }: { event: MachineEvent }) =>
                  event.type === "DOCS_UPDATED" ? event.docsReceived : 0,
              }),
            },
            {
              target: "docs_partial",
              guard: roleGuard(def.roles),
              actions: assign({
                docsRequired: ({ event }: { event: MachineEvent }) =>
                  event.type === "DOCS_UPDATED" ? event.docsRequired : 0,
                docsReceived: ({ event }: { event: MachineEvent }) =>
                  event.type === "DOCS_UPDATED" ? event.docsReceived : 0,
              }),
            },
          ]);
          break;

        case "ONBOARDED":
          add(from, def.event, {
            target: "onboarded",
            guard: roleGuard(def.roles),
          });
          break;

        case "STALL_DETECTED":
          add(from, def.event, {
            target: OVERLAY_STALLED,
            guard: roleGuard(def.roles),
            actions: assign({
              resumeState: () => from as StateId,
              stalledAt: () => new Date().toISOString(),
              stalledReason: ({ event }: { event: MachineEvent }) =>
                event.type === "STALL_DETECTED" ? event.reason : null,
            }),
          });
          break;

        case "CLIENT_ACTIVITY":
          // One guarded branch per resumable state; no branch matches when
          // resumeState is null → no transition → transition() throws.
          for (const sid of STALLABLE_STATES) {
            add(from, def.event, {
              target: sid,
              guard: and([
                roleGuard(def.roles),
                ({ context }: any) => context.resumeState === sid,
              ]),
              actions: assign({
                resumeState: () => null,
                stalledAt: () => null,
                stalledReason: () => null,
              }),
            });
          }
          break;

        case "MARK_CANCELED":
          add(from, def.event, {
            target: "canceled",
            guard: roleGuard(def.roles),
          });
          break;

        case "MARK_NO_SHOW":
          add(from, def.event, {
            target: "no_show",
            guard: roleGuard(def.roles),
          });
          break;

        case "MARK_LOST":
          add(from, def.event, {
            target: "lost",
            guard: roleGuard(def.roles),
          });
          break;
      }
    }
  }
  return states;
}

export const onboardingMachine = createMachine({
  id: "cpaOnboarding",
  initial: "booked",
  types: {} as { context: CpaContext; events: MachineEvent },
  context: baseContext(""),
  states: buildStates(),
});

/* ------------------------------------------------------------------ */
/* transition() — the helper API routes use                              */
/* ------------------------------------------------------------------ */

export class TransitionNotAllowed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionNotAllowed";
  }
}

export interface TransitionStep {
  from: PersistedState;
  to: PersistedState;
  event: EventType;
}

export interface TransitionResult {
  state: PersistedState;
  context: CpaContext;
  /** One step normally; two when a stalled client is auto-resumed first. */
  steps: TransitionStep[];
}

/**
 * Events that are meaningful while stalled (no auto-resume needed).
 * STALL_DETECTED is listed so re-detection goes straight to the machine,
 * which rejects it — the stall-check job treats that as "already stalled".
 * Anything else applied to a stalled client first resumes via CLIENT_ACTIVITY,
 * then applies — both steps are returned so routes persist both rows.
 */
const STALLED_NATIVE_EVENTS: EventType[] = [
  "CLIENT_ACTIVITY",
  "STALL_DETECTED",
  "MARK_CANCELED",
  "MARK_NO_SHOW",
  "MARK_LOST",
];

function describeBlocker(
  from: PersistedState,
  event: MachineEvent,
  ctx: CpaContext,
): string {
  const def = ACTION_BY_EVENT.get(event.type);
  if (!def || !def.from.includes(from)) {
    return `Event ${event.type} is not allowed from state '${from}'.`;
  }
  if (!def.roles.includes(event.actor.role)) {
    return (
      `Role '${event.actor.role}' may not trigger ${event.type} ` +
      `(allowed: ${def.roles.join(", ")}).`
    );
  }
  if (
    def.requiresOwnerApproval &&
    ctx.ownerApprovalForScopeVersion !== ctx.scopeVersion
  ) {
    return (
      `Owner approval is required for scope version ${ctx.scopeVersion} ` +
      `before the engagement letter can be sent.`
    );
  }
  return `Transition ${event.type} from '${from}' was blocked by a guard.`;
}

function applyOnce(
  from: PersistedState | null,
  event: MachineEvent,
  ctx: CpaContext,
): { state: PersistedState; context: CpaContext } {
  // Client creation: there is no prior state; BOOKING_CREATED starts the pipeline.
  if (from === null) {
    if (event.type !== "BOOKING_CREATED") {
      throw new TransitionNotAllowed(
        `Cannot apply ${event.type} to a client with no state; expected BOOKING_CREATED.`,
      );
    }
    return { state: "booked", context: ctx };
  }

  const actor = createActor(onboardingMachine, {
    state: onboardingMachine.resolveState({ value: from, context: ctx }),
  });
  actor.start();
  const before = actor.getSnapshot();
  actor.send(event);
  const after = actor.getSnapshot();
  actor.stop();

  const changed =
    after.value !== before.value ||
    JSON.stringify(after.context) !== JSON.stringify(before.context);
  // Idempotent re-fire of a booking webhook on an already-booked client is a
  // success no-op (dedupe happens in the route layer too).
  const idempotentNoop = event.type === "BOOKING_CREATED" && from === "booked";
  if (!changed && !idempotentNoop) {
    throw new TransitionNotAllowed(describeBlocker(from, event, ctx));
  }
  return { state: after.value as PersistedState, context: after.context };
}

/**
 * Apply one machine event to a client's persisted position.
 * Pure (no I/O): routes persist the returned steps in one DB transaction.
 */
export function transition(
  from: PersistedState | null,
  event: MachineEvent,
  ctx: CpaContext,
): TransitionResult {
  const chain: MachineEvent[] = [];
  if (from === OVERLAY_STALLED && !STALLED_NATIVE_EVENTS.includes(event.type)) {
    chain.push({
      type: "CLIENT_ACTIVITY",
      actor: event.actor,
      activity: `auto-resume before ${event.type}`,
    });
  }
  chain.push(event);

  let state = from;
  let context = ctx;
  const steps: TransitionStep[] = [];
  for (const ev of chain) {
    const next = applyOnce(state, ev, context);
    steps.push({ from: state as PersistedState, to: next.state, event: ev.type });
    state = next.state;
    context = next.context;
  }
  return { state: state as PersistedState, context, steps };
}

/* ------------------------------------------------------------------ */
/* allowedActions() — what the UI may offer for a state                  */
/* ------------------------------------------------------------------ */

export interface AllowedAction {
  event: EventType;
  label: string;
  description: string;
  requiresOwnerApproval: boolean;
}

/**
 * Actions offerable from `state` to an actor with `role`, honoring
 * context-level guards (e.g. DOCUSIGN_SENT is hidden until the owner has
 * approved the current scope version).
 */
export function allowedActions(
  state: PersistedState,
  ctx: CpaContext,
  role: Role,
): AllowedAction[] {
  return ACTIONS.filter((def) => {
    if (!def.from.includes(state)) return false;
    if (!def.roles.includes(role)) return false;
    if (
      def.requiresOwnerApproval &&
      ctx.ownerApprovalForScopeVersion !== ctx.scopeVersion
    ) {
      return false;
    }
    return true;
  }).map((def) => ({
    event: def.event,
    label: def.label,
    description: def.description,
    requiresOwnerApproval: !!def.requiresOwnerApproval,
  }));
}

/** True for the three terminal dispositions (no onward transitions except re-booking). */
export function isTerminal(state: PersistedState): boolean {
  return (TERMINAL_DISPOSITIONS as readonly string[]).includes(state);
}
