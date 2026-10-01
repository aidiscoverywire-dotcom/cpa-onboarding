/**
 * MOCK — dev/test only, never production.
 *
 * In-memory implementations of all six vendor adapter interfaces. Every
 * mock records its calls (created envelopes, created drafts, file requests,
 * organizer deliveries, ...) so tests and dev flows can assert on them.
 *
 * These mocks NEVER touch the network. The public webhook ingress and any
 * production runtime must only ever receive adapters built by the `adapters()`
 * factory in `index.ts`, which returns real implementations when
 * `INTEGRATIONS_LIVE=true` and all required secrets are present.
 */
import type {
  CalendlyAdapter,
  CalendlyEvent,
  DocuSignAdapter,
  DropboxAdapter,
  GmailAdapter,
  IntakeSubmission,
  OrganizerAdapter,
  TypeformAdapter,
} from "./types";
import { parseCalendlyEvent, verifyCalendlySignature } from "./calendly";
import { verifyDocuSignConnectSignature } from "./docusign";
import {
  parseTypeformSubmission,
  verifyTypeformSignature,
} from "./typeform";
import { fileRequestRef } from "./dropbox";

/**
 * MOCK — dev/test only, never production.
 * Signature verification and event parsing delegate to the REAL pure
 * functions (so contract behavior is tested); only network-touching methods
 * are faked in memory.
 */
export class MockCalendlyAdapter implements CalendlyAdapter {
  readonly parsedEvents: CalendlyEvent[] = [];

  verifySignature(rawBody: Buffer, header: string, key: string): boolean {
    return verifyCalendlySignature(rawBody, header, key);
  }

  parseEvent(body: unknown): CalendlyEvent {
    const ev = parseCalendlyEvent(body);
    this.parsedEvents.push(ev);
    return ev;
  }
}

export interface MockEnvelopeInput {
  templateId: string;
  clientEmail: string;
  clientName: string;
  roleName: string;
  tabValues: Record<string, string>;
}

/**
 * MOCK — dev/test only, never production.
 *
 * Enforces the same contract the real DocuSign API enforces:
 *  - `roleName` must EXACTLY match the template's role name (constructor-arg,
 *    default "Client") — mismatch throws, mirroring DocuSign's 400.
 *  - `clientUserId` must be ABSENT (remote email signing) — presence throws,
 *    mirroring the binding design decision.
 */
export class MockDocuSignAdapter implements DocuSignAdapter {
  readonly sentEnvelopes: Array<MockEnvelopeInput & { envelopeId: string }> = [];
  readonly downloaded: string[] = [];
  private envelopeSeq = 0;
  private tokenSeq = 0;
  lastToken: string | null = null;

  constructor(private readonly expectedRoleName = "Client") {}

  async getToken(): Promise<string> {
    this.tokenSeq += 1;
    this.lastToken = `mock-docusign-token-${this.tokenSeq}`;
    return this.lastToken;
  }

  async createEnvelopeFromTemplate(input: {
    templateId: string;
    clientEmail: string;
    clientName: string;
    roleName: string;
    tabValues: Record<string, string>;
  }): Promise<{ envelopeId: string }> {
    if (input.roleName !== this.expectedRoleName) {
      throw new Error(
        `MockDocuSignAdapter: roleName "${input.roleName}" does not exactly match template role "${this.expectedRoleName}"`,
      );
    }
    if ("clientUserId" in (input as Record<string, unknown>)) {
      throw new Error(
        "MockDocuSignAdapter: clientUserId must be omitted (remote email signing)",
      );
    }
    this.envelopeSeq += 1;
    const envelopeId = `mock-envelope-${this.envelopeSeq}`;
    this.sentEnvelopes.push({ ...input, envelopeId });
    return { envelopeId };
  }

  async getEnvelopeStatus(envelopeId: string): Promise<{ status: string }> {
    const found = this.sentEnvelopes.some((e) => e.envelopeId === envelopeId);
    return { status: found ? "sent" : "unknown" };
  }

  async downloadCombined(envelopeId: string): Promise<Buffer> {
    this.downloaded.push(envelopeId);
    return Buffer.from(`mock-combined-document:${envelopeId}`, "utf8");
  }

  verifyConnectSignature(rawBody: Buffer, header: string, key: string): boolean {
    return verifyDocuSignConnectSignature(rawBody, header, key);
  }
}

export interface MockDraft {
  draftId: string;
  to: string;
  subject: string;
  html: string;
  threadId?: string;
}

/**
 * MOCK — dev/test only, never production.
 *
 * Records created drafts for assertions. There is deliberately NO send
 * method on this class (or the GmailAdapter interface): drafts are
 * staff-reviewed and sent manually from Gmail. Do not add one.
 */
export class MockGmailAdapter implements GmailAdapter {
  readonly createdDrafts: MockDraft[] = [];
  private draftSeq = 0;

  async createDraft(input: {
    to: string;
    subject: string;
    html: string;
    threadId?: string;
  }): Promise<{ draftId: string }> {
    this.draftSeq += 1;
    const draft: MockDraft = {
      draftId: `mock-draft-${this.draftSeq}`,
      to: input.to,
      subject: input.subject,
      html: input.html,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    };
    this.createdDrafts.push(draft);
    return { draftId: draft.draftId };
  }
}

export interface MockSubmissionRecord extends IntakeSubmission {
  rawChecksum: string;
}

/**
 * MOCK — dev/test only, never production.
 *
 * Records submissions by submission id and rejects duplicates, mirroring the
 * receiver's unique-constraint + raw-body-checksum replay defense.
 */
export class MockTypeformAdapter implements TypeformAdapter {
  readonly submissions = new Map<string, MockSubmissionRecord>();

  verifySignature(rawBody: Buffer, header: string, secret: string): boolean {
    return verifyTypeformSignature(rawBody, header, secret);
  }

  parseSubmission(body: unknown): IntakeSubmission {
    const sub = parseTypeformSubmission(body);
    if (this.submissions.has(sub.submissionId)) {
      throw new Error(
        `MockTypeformAdapter: duplicate submission id "${sub.submissionId}" (replay rejected)`,
      );
    }
    this.submissions.set(sub.submissionId, { ...sub, rawChecksum: "mock" });
    return sub;
  }
}

/**
 * MOCK — dev/test only, never production.
 * Records file requests; uses the same PII-free reference scheme as the real adapter.
 */
export class MockDropboxAdapter implements DropboxAdapter {
  readonly fileRequests: Array<{
    url: string;
    requestId: string;
    year: number;
    expiresAt: string;
    ref: string;
  }> = [];
  private reqSeq = 0;

  async createFileRequest(input: {
    clientName: string;
    year: number;
    expiresAt: string;
  }): Promise<{ url: string; requestId: string }> {
    const ref = fileRequestRef(input.clientName, input.year);
    this.reqSeq += 1;
    const record = {
      url: `https://www.dropbox.com/request/mock/${ref.toLowerCase()}-${this.reqSeq}`,
      requestId: `mock-fr-${this.reqSeq}`,
      year: input.year,
      expiresAt: input.expiresAt,
      ref,
    };
    this.fileRequests.push(record);
    return { url: record.url, requestId: record.requestId };
  }
}

/**
 * MOCK — dev/test only, never production.
 * Records organizer dispatches as staff-executed (Phase 1: no vendor).
 */
export class MockOrganizerAdapter implements OrganizerAdapter {
  readonly deliveries: Array<{
    deliveryId: string;
    clientEmail: string;
    clientName: string;
    scopeVersion: number;
  }> = [];
  private deliverySeq = 0;

  async sendOrganizer(input: {
    clientEmail: string;
    clientName: string;
    scopeVersion: number;
  }): Promise<{ deliveryId: string }> {
    this.deliverySeq += 1;
    const delivery = { deliveryId: `mock-delivery-${this.deliverySeq}`, ...input };
    this.deliveries.push(delivery);
    return { deliveryId: delivery.deliveryId };
  }
}
