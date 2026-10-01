/**
 * Acceptance tests for the binding state-machine transitions (BUILD_BRIEF §3).
 * Every test drives a REAL XState v5 actor through `transition()` — no stubs.
 */
import { describe, expect, it } from "vitest";
import {
  allowedActions,
  baseContext,
  transition,
  TransitionNotAllowed,
  type ActorRef,
  type CpaContext,
  type MachineEvent,
  type PersistedState,
} from "./machine";

const owner: ActorRef = { id: "u-owner", type: "user", role: "owner" };
const staff: ActorRef = { id: "u-staff", type: "user", role: "staff" };
const partner: ActorRef = { id: "u-partner", type: "user", role: "partner" };
const webhook: ActorRef = { id: "webhook:calendly", type: "webhook", role: "webhook" };
const system: ActorRef = { id: "job:stall-check", type: "system", role: "system" };

function ctx(overrides: Partial<CpaContext> = {}): CpaContext {
  return { ...baseContext("client-1"), ...overrides };
}

/** Drive a client from `from` through a list of events; returns the final result. */
function drive(
  from: PersistedState | null,
  events: MachineEvent[],
  start: CpaContext = ctx(),
) {
  let state = from;
  let context = start;
  for (const ev of events) {
    const r = transition(state, ev, context);
    state = r.state;
    context = r.context;
  }
  return { state, context };
}

const approve = (c: CpaContext): CpaContext => ({
  ...c,
  ownerApprovalForScopeVersion: c.scopeVersion,
});

describe("booking + intake", () => {
  it("BOOKING_CREATED starts a client at 01 booked", () => {
    const r = transition(null, { type: "BOOKING_CREATED", actor: webhook }, ctx());
    expect(r.state).toBe("booked");
    expect(r.steps).toHaveLength(1);
  });

  it("new clients reject any event other than BOOKING_CREATED", () => {
    expect(() =>
      transition(null, { type: "MEETING_DONE", actor: staff }, ctx()),
    ).toThrow(TransitionNotAllowed);
  });

  it("02→03 on INTAKE_MATCHED", () => {
    const r = transition(
      "intake_missing",
      { type: "INTAKE_MATCHED", actor: webhook, submissionId: "sub-1" },
      ctx(),
    );
    expect(r.state).toBe("intake_received");
  });

  it("02→04 ONLY via INTAKE_WAIVED (owner)", () => {
    const r = transition(
      "intake_missing",
      { type: "INTAKE_WAIVED", actor: owner, waiverId: "w-1", reason: "VIP referral" },
      ctx(),
    );
    expect(r.state).toBe("brief_ready");
  });

  it("02→04 rejects INTAKE_WAIVED by staff (owner/admin only)", () => {
    expect(() =>
      transition(
        "intake_missing",
        { type: "INTAKE_WAIVED", actor: staff, waiverId: "w-1", reason: "x" },
        ctx(),
      ),
    ).toThrow(/Role 'staff' may not trigger INTAKE_WAIVED/);
  });

  it("02→04 cannot be reached by BRIEF_APPROVED (wrong event for the state)", () => {
    expect(() =>
      transition("intake_missing", { type: "BRIEF_APPROVED", actor: owner }, ctx()),
    ).toThrow(/not allowed from state 'intake_missing'/);
  });

  it("03→04 on BRIEF_APPROVED", () => {
    const r = transition("intake_received", { type: "BRIEF_APPROVED", actor: staff }, ctx());
    expect(r.state).toBe("brief_ready");
  });

  it("04→05 on MEETING_DONE", () => {
    const r = transition("brief_ready", { type: "MEETING_DONE", actor: staff }, ctx());
    expect(r.state).toBe("meeting_done");
  });
});

describe("commercial path + bypasses", () => {
  it("05→06 on APPLY_DISCOUNT (owner/partner only)", () => {
    const r = transition(
      "meeting_done",
      { type: "APPLY_DISCOUNT", actor: partner, discountPct: 10 },
      ctx(),
    );
    expect(r.state).toBe("discount_applied");
  });

  it("APPLY_DISCOUNT rejects staff role", () => {
    expect(() =>
      transition(
        "meeting_done",
        { type: "APPLY_DISCOUNT", actor: staff, discountPct: 10 },
        ctx(),
      ),
    ).toThrow(/Role 'staff' may not trigger APPLY_DISCOUNT/);
  });

  it("commercial bypass 05→08 on DOCUSIGN_SENT (with owner approval)", () => {
    const r = transition(
      "meeting_done",
      { type: "DOCUSIGN_SENT", actor: staff, envelopeId: "env-1" },
      approve(ctx()),
    );
    expect(r.state).toBe("docusign_sent");
  });

  it("commercial bypass 06→08 on DOCUSIGN_SENT (with owner approval)", () => {
    const r = transition(
      "discount_applied",
      { type: "DOCUSIGN_SENT", actor: staff, envelopeId: "env-1" },
      approve(ctx()),
    );
    expect(r.state).toBe("docusign_sent");
  });

  it("commercial bypass 06→07 on SCOPE_CHANGED", () => {
    const r = transition("discount_applied", { type: "SCOPE_CHANGED", actor: staff }, ctx());
    expect(r.state).toBe("scope_changed");
    expect(r.context.scopeVersion).toBe(2);
    expect(r.context.voidUnsignedEnvelope).toBe(false);
    expect(r.context.supersedeSignedEnvelope).toBe(false);
  });

  it("commercial bypass 07→08 on DOCUSIGN_SENT (with owner approval)", () => {
    const r = transition(
      "scope_changed",
      { type: "DOCUSIGN_SENT", actor: staff, envelopeId: "env-1" },
      approve(ctx({ scopeVersion: 2 })),
    );
    expect(r.state).toBe("docusign_sent");
  });

  it("DOCUSIGN_SENT is blocked without owner approval for the current scope version", () => {
    expect(() =>
      transition(
        "meeting_done",
        { type: "DOCUSIGN_SENT", actor: owner, envelopeId: "env-1" },
        ctx(), // ownerApprovalForScopeVersion === null
      ),
    ).toThrow(/Owner approval is required for scope version 1/);
  });

  it("DOCUSIGN_SENT is blocked when approval is for a stale scope version", () => {
    const c = ctx({ scopeVersion: 2, ownerApprovalForScopeVersion: 1 });
    expect(() =>
      transition(
        "scope_changed",
        { type: "DOCUSIGN_SENT", actor: owner, envelopeId: "env-1" },
        c,
      ),
    ).toThrow(/Owner approval is required for scope version 2/);
  });

  it("SCOPE_CHANGED clears a previous owner approval", () => {
    const r = transition(
      "meeting_done",
      { type: "SCOPE_CHANGED", actor: staff },
      approve(ctx()),
    );
    expect(r.context.ownerApprovalForScopeVersion).toBe(null);
    expect(r.context.scopeVersion).toBe(2);
  });
});

describe("SCOPE_CHANGED from post-signature states (08–13 → 07)", () => {
  it("08→07 flags the unsigned envelope for voiding", () => {
    const r = transition("docusign_sent", { type: "SCOPE_CHANGED", actor: staff }, ctx());
    expect(r.state).toBe("scope_changed");
    expect(r.context.voidUnsignedEnvelope).toBe(true);
    expect(r.context.supersedeSignedEnvelope).toBe(false);
  });

  it.each([
    "docusign_signed",
    "dropbox_request_ready",
    "organizer_sent",
    "docs_partial",
    "docs_complete",
  ] as const)("%s → 07 flags the signed envelope for supersession", (from) => {
    const r = transition(from, { type: "SCOPE_CHANGED", actor: staff }, ctx());
    expect(r.state).toBe("scope_changed");
    expect(r.context.voidUnsignedEnvelope).toBe(false);
    expect(r.context.supersedeSignedEnvelope).toBe(true);
    expect(r.context.scopeVersion).toBe(2);
  });

  it("scope→envelope linkage is explicit: flags travel in context, never by accident", () => {
    const r = transition("docusign_signed", { type: "SCOPE_CHANGED", actor: owner }, ctx());
    expect(r.context.scopeVersion).toBe(2);
    // A fresh DOCUSIGN_SENT from 07 still needs fresh owner approval.
    expect(() =>
      transition(r.state, { type: "DOCUSIGN_SENT", actor: owner, envelopeId: "e2" }, r.context),
    ).toThrow(/Owner approval is required for scope version 2/);
  });
});

describe("signature-first ordering (structural)", () => {
  it("08→09 on DOCUSIGN_SIGNED, then 09→10 on DROPBOX_READY", () => {
    const { state, context } = drive("docusign_sent", [
      { type: "DOCUSIGN_SIGNED", actor: webhook },
      { type: "DROPBOX_READY", actor: webhook, fileRequestId: "fr-1" },
    ]);
    expect(state).toBe("dropbox_request_ready");
    expect(context.docsRequired).toBe(0);
  });

  it("no event requests documents before signature: DOCS_UPDATED from 08 is rejected", () => {
    expect(() =>
      transition(
        "docusign_sent",
        { type: "DOCS_UPDATED", actor: webhook, docsRequired: 5, docsReceived: 5 },
        ctx(),
      ),
    ).toThrow(/not allowed from state 'docusign_sent'/);
  });

  it("DROPBOX_READY from 08 (unsigned) is rejected", () => {
    expect(() =>
      transition("docusign_sent", { type: "DROPBOX_READY", actor: webhook }, ctx()),
    ).toThrow(/not allowed from state 'docusign_sent'/);
  });

  it("10→11 on ORGANIZER_SENT", () => {
    const r = transition("dropbox_request_ready", { type: "ORGANIZER_SENT", actor: webhook }, ctx());
    expect(r.state).toBe("organizer_sent");
  });
});

describe("DOCS_UPDATED auto-derivation", () => {
  it("derives docs_complete when received >= required", () => {
    const r = transition(
      "organizer_sent",
      { type: "DOCS_UPDATED", actor: webhook, docsRequired: 4, docsReceived: 4 },
      ctx(),
    );
    expect(r.state).toBe("docs_complete");
    expect(r.context.docsReceived).toBe(4);
  });

  it("derives docs_partial when received < required", () => {
    const r = transition(
      "dropbox_request_ready",
      { type: "DOCS_UPDATED", actor: webhook, docsRequired: 4, docsReceived: 1 },
      ctx(),
    );
    expect(r.state).toBe("docs_partial");
  });

  it("a checklist regression moves docs_complete back to docs_partial", () => {
    const r = transition(
      "docs_complete",
      { type: "DOCS_UPDATED", actor: staff, docsRequired: 4, docsReceived: 2 },
      ctx({ docsRequired: 4, docsReceived: 4 }),
    );
    expect(r.state).toBe("docs_partial");
  });

  it("13→14 on ONBOARDED", () => {
    const r = transition("docs_complete", { type: "ONBOARDED", actor: staff }, ctx());
    expect(r.state).toBe("onboarded");
  });

  it("ONBOARDED from docs_partial is rejected", () => {
    expect(() =>
      transition("docs_partial", { type: "ONBOARDED", actor: owner }, ctx()),
    ).toThrow(/not allowed from state 'docs_partial'/);
  });
});

describe("stalled overlay", () => {
  it("STALL_DETECTED from a non-terminal state stores resumeState", () => {
    const r = transition(
      "meeting_done",
      { type: "STALL_DETECTED", actor: system, reason: "no activity 72h" },
      ctx(),
    );
    expect(r.state).toBe("stalled");
    expect(r.context.resumeState).toBe("meeting_done");
    expect(r.context.stalledReason).toBe("no activity 72h");
    expect(r.context.stalledAt).not.toBe(null);
  });

  it("CLIENT_ACTIVITY resumes the stored state and clears stall fields", () => {
    const stalled = transition(
      "brief_ready",
      { type: "STALL_DETECTED", actor: system, reason: "idle" },
      ctx(),
    );
    const r = transition(
      stalled.state,
      { type: "CLIENT_ACTIVITY", actor: webhook, activity: "intake submitted" },
      stalled.context,
    );
    expect(r.state).toBe("brief_ready");
    expect(r.context.resumeState).toBe(null);
    expect(r.context.stalledAt).toBe(null);
  });

  it("STALL_DETECTED is rejected from onboarded and from terminal dispositions", () => {
    for (const from of ["onboarded", "canceled", "no_show", "lost"] as const) {
      expect(() =>
        transition(from, { type: "STALL_DETECTED", actor: system, reason: "x" }, ctx()),
      ).toThrow(TransitionNotAllowed);
    }
  });

  it("re-detecting a stall while stalled is a no-op rejection", () => {
    const stalled = transition(
      "meeting_done",
      { type: "STALL_DETECTED", actor: system, reason: "idle" },
      ctx(),
    );
    expect(() =>
      transition(
        stalled.state,
        { type: "STALL_DETECTED", actor: system, reason: "again" },
        stalled.context,
      ),
    ).toThrow(TransitionNotAllowed);
  });

  it("a webhook event on a stalled client auto-resumes first (two steps)", () => {
    const stalled = transition(
      "intake_missing",
      { type: "STALL_DETECTED", actor: system, reason: "idle" },
      ctx(),
    );
    const r = transition(
      stalled.state,
      { type: "INTAKE_MATCHED", actor: webhook, submissionId: "sub-9" },
      stalled.context,
    );
    expect(r.steps.map((s) => s.event)).toEqual(["CLIENT_ACTIVITY", "INTAKE_MATCHED"]);
    expect(r.steps[0]).toMatchObject({ from: "stalled", to: "intake_missing" });
    expect(r.state).toBe("intake_received");
  });

  it("CLIENT_ACTIVITY with no stored resumeState is rejected", () => {
    expect(() =>
      transition(
        "stalled",
        { type: "CLIENT_ACTIVITY", actor: webhook, activity: "ping" },
        ctx(), // resumeState null
      ),
    ).toThrow(TransitionNotAllowed);
  });
});

describe("terminal dispositions", () => {
  it("MARK_CANCELED from an early state (02)", () => {
    const r = transition("intake_missing", { type: "MARK_CANCELED", actor: webhook }, ctx());
    expect(r.state).toBe("canceled");
  });

  it("MARK_NO_SHOW from stalled", () => {
    const stalled = transition(
      "booked",
      { type: "STALL_DETECTED", actor: system, reason: "idle" },
      ctx(),
    );
    const r = transition(stalled.state, { type: "MARK_NO_SHOW", actor: webhook }, stalled.context);
    expect(r.state).toBe("no_show");
  });

  it("MARK_LOST from an early state (05), staff only", () => {
    const r = transition(
      "meeting_done",
      { type: "MARK_LOST", actor: staff, reason: "chose competitor" },
      ctx(),
    );
    expect(r.state).toBe("lost");
    expect(() =>
      transition("meeting_done", { type: "MARK_LOST", actor: webhook }, ctx()),
    ).toThrow(/Role 'webhook' may not trigger MARK_LOST/);
  });

  it("terminal dispositions are rejected from post-signature states", () => {
    expect(() =>
      transition("docusign_sent", { type: "MARK_CANCELED", actor: staff }, ctx()),
    ).toThrow(/not allowed from state 'docusign_sent'/);
    expect(() =>
      transition("docs_complete", { type: "MARK_LOST", actor: owner }, ctx()),
    ).toThrow(/not allowed from state 'docs_complete'/);
  });

  it("a canceled prospect can re-book (BOOKING_CREATED from canceled)", () => {
    const r = transition("canceled", { type: "BOOKING_CREATED", actor: webhook }, ctx());
    expect(r.state).toBe("booked");
  });

  it("terminal states offer no onward actions", () => {
    for (const s of ["canceled", "no_show", "lost", "onboarded"] as const) {
      const actions = allowedActions(s, ctx(), "staff").map((a) => a.event);
      expect(actions).not.toContain("STALL_DETECTED");
      expect(actions).not.toContain("MARK_CANCELED");
    }
  });
});

describe("allowedActions()", () => {
  it("hides DOCUSIGN_SENT until the owner approves the current scope version", () => {
    const hidden = allowedActions("meeting_done", ctx(), "staff").map((a) => a.event);
    expect(hidden).not.toContain("DOCUSIGN_SENT");
    const shown = allowedActions("meeting_done", approve(ctx()), "staff").map((a) => a.event);
    expect(shown).toContain("DOCUSIGN_SENT");
  });

  it("exposes only role-permitted actions", () => {
    const staffActions = allowedActions("intake_missing", ctx(), "staff").map((a) => a.event);
    expect(staffActions).toContain("INTAKE_MATCHED");
    expect(staffActions).not.toContain("INTAKE_WAIVED");
    const ownerActions = allowedActions("intake_missing", ctx(), "owner").map((a) => a.event);
    expect(ownerActions).toContain("INTAKE_WAIVED");
  });

  it("offers CLIENT_ACTIVITY + terminal dispositions while stalled", () => {
    const events = allowedActions(
      "stalled",
      ctx({ resumeState: "meeting_done" }),
      "staff",
    ).map((a) => a.event);
    expect(events).toEqual(
      expect.arrayContaining(["CLIENT_ACTIVITY", "MARK_CANCELED", "MARK_NO_SHOW", "MARK_LOST"]),
    );
  });

  it("every action descriptor carries label + description", () => {
    for (const a of allowedActions("meeting_done", approve(ctx()), "owner")) {
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.description.length).toBeGreaterThan(0);
    }
  });
});

describe("full happy-path drive", () => {
  it("walks 01→14 through every state", () => {
    const events: MachineEvent[] = [
      { type: "BOOKING_CREATED", actor: webhook },
    ];
    const created = transition(null, events[0], ctx());
    expect(created.state).toBe("booked");
    void events;
    // Manually step: booking starts at booked; INTAKE_REQUESTED moves it to
    // intake_missing when no submission matched at booking time.
    let { state, context } = { state: created.state as PersistedState, context: created.context };
    const step = (ev: MachineEvent) => {
      const r = transition(state, ev, context);
      state = r.state;
      context = r.context;
    };
    step({ type: "INTAKE_REQUESTED", actor: webhook });
    expect(state).toBe("intake_missing");
    step({ type: "INTAKE_MATCHED", actor: webhook, submissionId: "s1" });
    expect(state).toBe("intake_received");
    step({ type: "BRIEF_APPROVED", actor: owner });
    step({ type: "MEETING_DONE", actor: staff });
    step({ type: "APPLY_DISCOUNT", actor: owner, discountPct: 15 });
    expect(state).toBe("discount_applied");
    step({ type: "SCOPE_CHANGED", actor: staff }); // 06→07 commercial bypass
    expect(state).toBe("scope_changed");
    context = { ...context, ownerApprovalForScopeVersion: context.scopeVersion };
    step({ type: "DOCUSIGN_SENT", actor: staff, envelopeId: "env-1" });
    step({ type: "DOCUSIGN_SIGNED", actor: webhook });
    step({ type: "DROPBOX_READY", actor: webhook });
    step({ type: "ORGANIZER_SENT", actor: webhook });
    step({ type: "DOCS_UPDATED", actor: webhook, docsRequired: 3, docsReceived: 2 });
    expect(state).toBe("docs_partial");
    step({ type: "DOCS_UPDATED", actor: webhook, docsRequired: 3, docsReceived: 3 });
    expect(state).toBe("docs_complete");
    step({ type: "ONBOARDED", actor: owner });
    expect(state).toBe("onboarded");
  });
});
