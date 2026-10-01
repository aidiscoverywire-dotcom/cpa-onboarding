/**
 * Vendor adapter interfaces for the CPA onboarding pipeline.
 *
 * Workstream (b) imports these exact interface names. Every integration is
 * behind an adapter so production vendors can be swapped for in-memory mocks
 * in dev/test (see `mocks.ts` and the `adapters()` factory in `index.ts`).
 *
 * Honesty rule: nothing here is live-verified — no vendor consoles are
 * reachable from this environment. Signatures and API shapes come from the
 * BUILD_BRIEF §5 spec and the 2026-09-30 integration research notes; treat
 * numeric claims (rate limits, retry counts) as unverified.
 */

/** Normalized Calendly booking event after signature verification. */
export interface CalendlyEvent {
  /** Invitee URI — the idempotency key (unique constraint on the receiver side). */
  inviteeUri: string;
  email: string;
  name: string;
  /** ISO 8601 timestamps from the scheduled event. */
  eventStart: string;
  eventEnd: string;
  /** Opaque event-type URI (receiver keeps a URI->slug map). */
  eventTypeUri: string;
  kind: "created" | "canceled" | "no_show";
  /** True when this event is part of a reschedule pair. */
  rescheduled: boolean;
  /** Present on the canceled half of a reschedule pair. */
  oldInviteeUri?: string;
  /** Present on the created half of a reschedule pair. */
  newInviteeUri?: string;
}

export interface CalendlyAdapter {
  /**
   * Verify the `Calendly-Webhook-Signature` header (`t=<unix>,v1=<hex>`) against
   * the RAW request body. Returns false (never throws) on missing/invalid
   * header, bad timestamp, or signature mismatch so routes can answer 401.
   */
  verifySignature(rawBody: Buffer, header: string, key: string): boolean;
  /** Parse a verified webhook envelope into a CalendlyEvent. Throws on unknown event types. */
  parseEvent(body: unknown): CalendlyEvent;
}

export interface DocuSignAdapter {
  /** OAuth access token via the JWT Grant. Cached ~55 min by the real implementation. */
  getToken(): Promise<string>;
  /**
   * Create + send an envelope from a template for the engagement letter.
   * `roleName` must EXACTLY match the role name defined in the template
   * (DocuSign rejects mismatches). `clientUserId` is deliberately omitted from
   * the envelope definition so the client signs via DocuSign's remote email
   * link (no embedded signing view).
   */
  createEnvelopeFromTemplate(input: {
    templateId: string;
    clientEmail: string;
    clientName: string;
    roleName: string;
    tabValues: Record<string, string>;
  }): Promise<{ envelopeId: string }>;
  getEnvelopeStatus(envelopeId: string): Promise<{ status: string }>;
  /** Download `documents/combined` (all docs + Certificate of Completion). */
  downloadCombined(envelopeId: string): Promise<Buffer>;
  /**
   * Verify the DocuSign Connect `X-DocuSign-Signature-1` header against the
   * RAW request body. Returns false (never throws) on missing/invalid header.
   */
  verifyConnectSignature(rawBody: Buffer, header: string, key: string): boolean;
}

export interface GmailAdapter {
  /**
   * Create a Gmail DRAFT for staff to review and send manually from Gmail.
   *
   * DELIBERATE DESIGN DECISION — NO SEND METHOD EXISTS HERE BY DESIGN:
   * `gmail.users.drafts.send` and `gmail.users.messages.send` must NEVER be
   * called from automation. Every client-facing email leaves this system as a
   * draft that a staff member explicitly sends. This is the binding firm
   * policy from BUILD_BRIEF §1/§5 ("Nothing is ever sent to clients
   * automatically"). Do not add a `send` method to this interface or any
   * implementation — a reviewer should reject such a change.
   */
  createDraft(input: {
    to: string;
    subject: string;
    /** HTML email body. */
    html: string;
    /** Optional thread to reply inside (pre-meeting email threading). */
    threadId?: string;
  }): Promise<{ draftId: string }>;
}

/** Normalized Typeform intake submission after signature verification. */
export interface IntakeSubmission {
  /** Idempotency key: the Typeform form-response token (unique constraint on the receiver side). */
  submissionId: string;
  email: string;
  /** Answers keyed by question title. */
  answers: Record<string, string>;
  /** ISO 8601 submission timestamp. */
  submittedAt: string;
}

export interface TypeformAdapter {
  /**
   * Verify the `Typeform-Signature` header (`sha256=` + Base64(HMAC-SHA256(raw
   * bytes, secret))). Constant-time compare; false on missing/invalid.
   */
  verifySignature(rawBody: Buffer, header: string, secret: string): boolean;
  /** Parse a verified webhook envelope into an IntakeSubmission. */
  parseSubmission(body: unknown): IntakeSubmission;
}

export interface DropboxAdapter {
  /**
   * Create a per-client/per-year Dropbox file request with an expiry.
   * The client name MUST NOT appear in the request title or URL — only an
   * opaque reference — so links stay possession-based and PII-free.
   */
  createFileRequest(input: {
    clientName: string;
    year: number;
    /** ISO 8601 expiry for the request. */
    expiresAt: string;
  }): Promise<{ url: string; requestId: string }>;
}

export interface OrganizerAdapter {
  /**
   * Dispatch the tax organizer through the settled upload surface.
   * Phase 1 has no settled vendor: the default provider is
   * `ManualOrganizerProvider` (records the staff-executed delivery); see
   * `organizer.ts`.
   */
  sendOrganizer(input: {
    clientEmail: string;
    clientName: string;
    scopeVersion: number;
  }): Promise<{ deliveryId: string }>;
}
