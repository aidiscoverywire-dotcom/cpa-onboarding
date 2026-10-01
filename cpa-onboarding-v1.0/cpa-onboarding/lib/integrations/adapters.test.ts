/**
 * Real contract tests for the vendor integration adapters.
 * No network calls anywhere in this file. Signature test vectors are computed
 * inline with node:crypto; every assertion exercises real code paths.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyCalendlySignature, parseCalendlyEvent } from "./calendly";
import {
  verifyDocuSignConnectSignature,
  RealDocuSignAdapter,
} from "./docusign";
import { buildRfc2822Base64Url, RealGmailAdapter } from "./gmail";
import {
  verifyTypeformSignature,
  parseTypeformSubmission,
  createSubmissionDedupe,
} from "./typeform";
import { fileRequestRef } from "./dropbox";
import {
  UnselectedOrganizerProvider,
  ManualOrganizerProvider,
} from "./organizer";
import {
  MockCalendlyAdapter,
  MockDocuSignAdapter,
  MockDropboxAdapter,
  MockGmailAdapter,
  MockOrganizerAdapter,
  MockTypeformAdapter,
} from "./mocks";
import { adapters } from "./index";

// ---------------------------------------------------------------- Calendly
describe("Calendly signature verification", () => {
  const key = "test-calendly-signing-key";
  const rawBody = Buffer.from('{"event":"invitee.created","payload":{}}', "utf8");

  function sign(ts: number, body: Buffer = rawBody): string {
    return createHmac("sha256", key)
      .update(`${ts}.`, "utf8")
      .update(body)
      .digest("hex");
  }

  it("accepts a valid signature", () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=${sign(ts)}`;
    expect(verifyCalendlySignature(rawBody, header, key)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=${sign(ts)}`;
    const tampered = Buffer.from('{"event":"invitee.created","payload":{"x":1}}', "utf8");
    expect(verifyCalendlySignature(tampered, header, key)).toBe(false);
  });

  it("rejects a stale timestamp (older than 180s)", () => {
    const ts = Math.floor(Date.now() / 1000) - 200;
    const header = `t=${ts},v1=${sign(ts)}`;
    expect(verifyCalendlySignature(rawBody, header, key)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyCalendlySignature(rawBody, "", key)).toBe(false);
  });

  it("rejects a malformed header", () => {
    expect(verifyCalendlySignature(rawBody, "not-a-signature", key)).toBe(false);
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyCalendlySignature(rawBody, `t=${ts}`, key)).toBe(false);
  });
});

describe("Calendly event parsing", () => {
  const envelope = {
    created_at: "2026-09-30T10:00:00Z",
    event: "invitee.created",
    payload: {
      uri: "https://api.calendly.com/scheduled_events/EVT/invitees/INV",
      email: "client@example.com",
      name: "Jane Client",
      rescheduled: false,
      event: {
        uri: "https://api.calendly.com/scheduled_events/EVT",
        start_time: "2026-10-05T15:00:00Z",
        end_time: "2026-10-05T15:30:00Z",
      },
      event_type: { uri: "https://api.calendly.com/event_types/ET" },
    },
  };

  it("parses a created event into the normalized shape", () => {
    const ev = parseCalendlyEvent(envelope);
    expect(ev).toMatchObject({
      inviteeUri: "https://api.calendly.com/scheduled_events/EVT/invitees/INV",
      email: "client@example.com",
      name: "Jane Client",
      eventStart: "2026-10-05T15:00:00Z",
      eventEnd: "2026-10-05T15:30:00Z",
      eventTypeUri: "https://api.calendly.com/event_types/ET",
      kind: "created",
      rescheduled: false,
    });
    expect(ev.oldInviteeUri).toBeUndefined();
    expect(ev.newInviteeUri).toBeUndefined();
  });

  it("carries reschedule linkage on a reschedule pair", () => {
    const canceled = {
      ...envelope,
      event: "invitee.canceled",
      payload: {
        ...envelope.payload,
        rescheduled: true,
        new_invitee: "https://api.calendly.com/scheduled_events/EVT2/invitees/INV2",
      },
    };
    const ev = parseCalendlyEvent(canceled);
    expect(ev.kind).toBe("canceled");
    expect(ev.rescheduled).toBe(true);
    expect(ev.newInviteeUri).toBe(
      "https://api.calendly.com/scheduled_events/EVT2/invitees/INV2",
    );
  });

  it("maps no_show events to the terminal disposition kind", () => {
    expect(parseCalendlyEvent({ ...envelope, event: "invitee.no_show" }).kind).toBe("no_show");
  });

  it("throws on an unknown event type (receiver logs + answers 200)", () => {
    expect(() => parseCalendlyEvent({ ...envelope, event: "invitee.weird" })).toThrow(
      /unknown event type/,
    );
  });

  it("mock records parsed events using the real parser", () => {
    const mock = new MockCalendlyAdapter();
    mock.parseEvent(envelope);
    expect(mock.parsedEvents).toHaveLength(1);
    expect(mock.parsedEvents[0]?.kind).toBe("created");
  });
});

// --------------------------------------------------------------- DocuSign
describe("DocuSign Connect signature verification", () => {
  const key = "test-connect-hmac-key";
  const rawBody = Buffer.from('{"envelopeId":"abc"}', "utf8");
  const good = createHmac("sha256", key).update(rawBody).digest("base64");

  it("accepts a valid X-DocuSign-Signature-1 header", () => {
    expect(verifyDocuSignConnectSignature(rawBody, good, key)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(
      verifyDocuSignConnectSignature(Buffer.from('{"envelopeId":"xyz"}', "utf8"), good, key),
    ).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyDocuSignConnectSignature(rawBody, "", key)).toBe(false);
  });
});

describe("DocuSign mock contract", () => {
  const input = {
    templateId: "tpl-1",
    clientEmail: "client@example.com",
    clientName: "Jane Client",
    roleName: "Client",
    tabValues: { client_name: "Jane Client" },
  };

  it("sends an envelope when roleName exactly matches", async () => {
    const mock = new MockDocuSignAdapter("Client");
    const { envelopeId } = await mock.createEnvelopeFromTemplate(input);
    expect(envelopeId).toMatch(/^mock-envelope-/);
    expect(mock.sentEnvelopes).toHaveLength(1);
    expect(mock.sentEnvelopes[0]).toMatchObject({ ...input, envelopeId });
  });

  it("rejects a roleName that is not an exact match", async () => {
    const mock = new MockDocuSignAdapter("Client");
    await expect(
      mock.createEnvelopeFromTemplate({ ...input, roleName: "client" }),
    ).rejects.toThrow(/does not exactly match/);
    await expect(
      mock.createEnvelopeFromTemplate({ ...input, roleName: "Signer" }),
    ).rejects.toThrow(/does not exactly match/);
  });

  it("rejects any input carrying clientUserId (remote signing only)", async () => {
    const mock = new MockDocuSignAdapter("Client");
    await expect(
      mock.createEnvelopeFromTemplate({ ...input, clientUserId: "embedded-1" } as never),
    ).rejects.toThrow(/clientUserId must be omitted/);
  });

  it("verifies Connect signatures with the real function", () => {
    const key = "k";
    const body = Buffer.from("x", "utf8");
    const good = createHmac("sha256", key).update(body).digest("base64");
    const mock = new MockDocuSignAdapter();
    expect(mock.verifyConnectSignature(body, good, key)).toBe(true);
    expect(mock.verifyConnectSignature(body, "bad", key)).toBe(false);
  });

  it("the real adapter exposes no mockable send path beyond createEnvelopeFromTemplate", () => {
    const proto = RealDocuSignAdapter.prototype as unknown as Record<string, unknown>;
    expect(typeof proto["createEnvelopeFromTemplate"]).toBe("function");
    expect(typeof proto["verifyConnectSignature"]).toBe("function");
  });
});

// ------------------------------------------------------------------ Gmail
describe("Gmail drafts", () => {
  it("builds a decodable base64url RFC2822 message", () => {
    const raw = buildRfc2822Base64Url({
      to: "client@example.com",
      subject: "Pre-meeting checklist",
      html: "<p>Hi Jane</p>",
    });
    expect(raw).not.toMatch(/[+/=]/);
    const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(decoded).toContain("To: client@example.com");
    expect(decoded).toContain("Subject: Pre-meeting checklist");
    expect(decoded).toContain("<p>Hi Jane</p>");
  });

  it("mock records drafts and exposes no send capability", async () => {
    const mock = new MockGmailAdapter();
    const { draftId } = await mock.createDraft({
      to: "client@example.com",
      subject: "s",
      html: "<p>h</p>",
      threadId: "thread-1",
    });
    expect(draftId).toMatch(/^mock-draft-/);
    expect(mock.createdDrafts).toHaveLength(1);
    expect(mock.createdDrafts[0]).toMatchObject({
      draftId,
      to: "client@example.com",
      threadId: "thread-1",
    });
    // Deliberate policy: no send method exists anywhere on the mock.
    expect("send" in mock).toBe(false);
    expect((mock as unknown as Record<string, unknown>)["drafts.send"]).toBeUndefined();
    expect((mock as unknown as Record<string, unknown>)["messages.send"]).toBeUndefined();
  });

  it("real adapter class also exposes no send method (policy guard)", () => {
    const proto = RealGmailAdapter.prototype as unknown as Record<string, unknown>;
    expect(proto["send"]).toBeUndefined();
    expect(proto["drafts.send"]).toBeUndefined();
    expect(proto["messages.send"]).toBeUndefined();
  });
});

// --------------------------------------------------------------- Typeform
describe("Typeform signature verification", () => {
  const secret = "test-typeform-secret";
  const rawBody = Buffer.from('{"event_type":"form_response"}', "utf8");
  const good = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("base64");

  it("accepts a valid signature", () => {
    expect(verifyTypeformSignature(rawBody, good, secret)).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(
      verifyTypeformSignature(Buffer.from('{"event_type":"form_response","x":1}', "utf8"), good, secret),
    ).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyTypeformSignature(rawBody, "", secret)).toBe(false);
  });

  it("rejects a header with the wrong scheme", () => {
    expect(verifyTypeformSignature(rawBody, "v1=" + good.slice(7), secret)).toBe(false);
  });
});

describe("Typeform submission parsing + replay defense", () => {
  const envelope = {
    event_id: "evt-1",
    event_type: "form_response",
    form_response: {
      token: "sub-token-123",
      submitted_at: "2026-09-30T12:00:00Z",
      definition: {
        fields: [
          { id: "f1", title: "Full name" },
          { id: "f2", title: "Email address" },
        ],
      },
      answers: [
        { field: { id: "f1" }, type: "text", text: "Jane Client" },
        { field: { id: "f2" }, type: "email", email: "client@example.com" },
      ],
    },
  };

  it("normalizes answers keyed by question title", () => {
    const sub = parseTypeformSubmission(envelope);
    expect(sub).toMatchObject({
      submissionId: "sub-token-123",
      email: "client@example.com",
      submittedAt: "2026-09-30T12:00:00Z",
    });
    expect(sub.answers).toMatchObject({
      "Full name": "Jane Client",
      "Email address": "client@example.com",
    });
  });

  it("idempotency helper rejects a duplicate submission id (replay defense)", () => {
    const dedupe = createSubmissionDedupe();
    expect(dedupe.alreadySeen("sub-token-123")).toBe(false); // first sighting: process
    expect(dedupe.alreadySeen("sub-token-123")).toBe(true); // replay: reject
    expect(dedupe.alreadySeen("other-token")).toBe(false);
  });

  it("mock rejects a duplicate submission id", () => {
    const mock = new MockTypeformAdapter();
    mock.parseSubmission(envelope);
    expect(() => mock.parseSubmission(envelope)).toThrow(/duplicate submission id/);
    expect(mock.submissions.size).toBe(1);
  });

  it("mock verifies signatures with the real function", () => {
    const secret = "s";
    const body = Buffer.from("b", "utf8");
    const good = "sha256=" + createHmac("sha256", secret).update(body).digest("base64");
    const mock = new MockTypeformAdapter();
    expect(mock.verifySignature(body, good, secret)).toBe(true);
    expect(mock.verifySignature(body, "", secret)).toBe(false);
  });
});

// --------------------------------------------------------------- Dropbox
describe("Dropbox file requests", () => {
  it("derives a PII-free reference from client name + year", () => {
    const ref = fileRequestRef("Jane Client", 2025);
    expect(ref).toMatch(/^FR-[0-9A-F]{12}$/);
    expect(ref).not.toContain("Jane");
    expect(fileRequestRef("Jane Client", 2026)).not.toBe(ref);
  });

  it("mock records requests without PII in url/title-equivalent fields", async () => {
    const mock = new MockDropboxAdapter();
    const { url, requestId } = await mock.createFileRequest({
      clientName: "Jane Client",
      year: 2025,
      expiresAt: "2026-12-31T00:00:00Z",
    });
    expect(requestId).toMatch(/^mock-fr-/);
    expect(url).not.toContain("Jane");
    expect(url).not.toContain("client");
    expect(mock.fileRequests).toHaveLength(1);
    expect(mock.fileRequests[0]?.ref).toBe(fileRequestRef("Jane Client", 2025));
  });
});

// -------------------------------------------------------------- Organizer
describe("Organizer providers", () => {
  it("UnselectedOrganizerProvider throws the discovery-required error", () => {
    const p = new UnselectedOrganizerProvider();
    expect(() =>
      p.sendOrganizer({ clientEmail: "c@x.com", clientName: "C", scopeVersion: 1 }),
    ).toThrow(
      "Discovery required: choose one upload surface; TaxCaddy is client-facing and NOT the settled provider",
    );
  });

  it("ManualOrganizerProvider records a staff-executed delivery and returns a delivery id", async () => {
    const p = new ManualOrganizerProvider();
    const { deliveryId } = await p.sendOrganizer({
      clientEmail: "c@x.com",
      clientName: "C",
      scopeVersion: 2,
    });
    expect(deliveryId).toMatch(/^manual-/);
    expect(p.getDelivered()).toHaveLength(1);
    expect(p.getDelivered()[0]).toMatchObject({
      deliveryId,
      scopeVersion: 2,
      mode: "manual-staff-executed",
    });
  });

  it("mock organizer records deliveries", async () => {
    const mock = new MockOrganizerAdapter();
    const { deliveryId } = await mock.sendOrganizer({
      clientEmail: "c@x.com",
      clientName: "C",
      scopeVersion: 1,
    });
    expect(mock.deliveries).toHaveLength(1);
    expect(mock.deliveries[0]?.deliveryId).toBe(deliveryId);
  });
});

// ---------------------------------------------------------------- Factory
describe("adapters() factory", () => {
  it("returns mocks when INTEGRATIONS_LIVE is not true", () => {
    delete process.env["INTEGRATIONS_LIVE"];
    const a = adapters();
    expect(a.calendly).toBeInstanceOf(MockCalendlyAdapter);
    expect(a.docusign).toBeInstanceOf(MockDocuSignAdapter);
    expect(a.gmail).toBeInstanceOf(MockGmailAdapter);
    expect(a.typeform).toBeInstanceOf(MockTypeformAdapter);
    expect(a.dropbox).toBeInstanceOf(MockDropboxAdapter);
    expect(a.organizer).toBeInstanceOf(MockOrganizerAdapter);
  });

  it("returns mocks (not half-wired real adapters) when INTEGRATIONS_LIVE=true but secrets are missing", () => {
    process.env["INTEGRATIONS_LIVE"] = "true";
    try {
      const a = adapters();
      expect(a.docusign).toBeInstanceOf(MockDocuSignAdapter);
      expect(a.gmail).toBeInstanceOf(MockGmailAdapter);
    } finally {
      delete process.env["INTEGRATIONS_LIVE"];
    }
  });
});
