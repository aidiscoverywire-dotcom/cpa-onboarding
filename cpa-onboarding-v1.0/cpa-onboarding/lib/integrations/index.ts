/**
 * Adapter factory for vendor integrations.
 *
 * `adapters()` returns REAL vendor implementations ONLY when
 * `INTEGRATIONS_LIVE=true` AND every required secret is present. Otherwise it
 * returns the in-memory mocks from `mocks.ts` (dev/test default).
 *
 * The factory logs which mode it chose at startup. It NEVER logs secret
 * values — only secret NAMES when reporting what is missing.
 */
import type {
  CalendlyAdapter,
  DocuSignAdapter,
  DropboxAdapter,
  GmailAdapter,
  OrganizerAdapter,
  TypeformAdapter,
} from "./types";
import { RealCalendlyAdapter } from "./calendly";
import { RealDocuSignAdapter } from "./docusign";
import { RealGmailAdapter } from "./gmail";
import { RealTypeformAdapter } from "./typeform";
import { RealDropboxAdapter } from "./dropbox";
import { ManualOrganizerProvider, UnselectedOrganizerProvider } from "./organizer";
import {
  MockCalendlyAdapter,
  MockDocuSignAdapter,
  MockDropboxAdapter,
  MockGmailAdapter,
  MockOrganizerAdapter,
  MockTypeformAdapter,
} from "./mocks";
import { env } from "../env";

export interface AdapterSet {
  calendly: CalendlyAdapter;
  docusign: DocuSignAdapter;
  gmail: GmailAdapter;
  typeform: TypeformAdapter;
  dropbox: DropboxAdapter;
  organizer: OrganizerAdapter;
}

export interface AdaptersOptions {
  /**
   * Per-user Gmail OAuth access token (required for the real Gmail adapter).
   * Supplied by the caller; refresh-token storage is workstream b's decision.
   */
  gmailAccessToken?: string;
  /**
   * Dropbox OAuth access token (required for the real Dropbox adapter).
   * In prod this comes from Secret Manager via the caller/workstream b.
   */
  dropboxAccessToken?: string;
}

function requiredSecretsMissing(opts: AdaptersOptions): string[] {
  const missing: string[] = [];
  const d = env.docusign;
  if (!env.calendlySigningKey) missing.push("CALENDLY_SIGNING_KEY");
  if (!env.typeformSecret) missing.push("TYPEFORM_SECRET");
  if (!d.integrationKey) missing.push("DOCUSIGN_INTEGRATION_KEY");
  if (!d.rsaPrivateKey) missing.push("DOCUSIGN_RSA_PRIVATE_KEY");
  if (!d.userId) missing.push("DOCUSIGN_USER_ID");
  if (!d.accountId) missing.push("DOCUSIGN_ACCOUNT_ID");
  if (!d.connectHmacKey) missing.push("DOCUSIGN_CONNECT_HMAC_KEY");
  if (!opts.gmailAccessToken) missing.push("gmail per-user OAuth access token (caller-supplied)");
  if (!(opts.dropboxAccessToken ?? process.env["DROPBOX_ACCESS_TOKEN"]))
    missing.push("DROPBOX_ACCESS_TOKEN");
  return missing;
}

export function adapters(opts: AdaptersOptions = {}): AdapterSet {
  const missing = requiredSecretsMissing(opts);
  if (env.integrationsLive && missing.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      "[integrations] LIVE mode: using real Calendly/DocuSign/Gmail/Typeform/Dropbox adapters; organizer = ManualOrganizerProvider (Phase 1, no vendor)",
    );
    return {
      calendly: new RealCalendlyAdapter(),
      docusign: new RealDocuSignAdapter(),
      gmail: new RealGmailAdapter(opts.gmailAccessToken as string),
      typeform: new RealTypeformAdapter(),
      dropbox: new RealDropboxAdapter(opts.dropboxAccessToken),
      // Phase 1: no settled organizer vendor — deliveries are recorded as
      // staff-executed. UnselectedOrganizerProvider is exported separately
      // for code paths that must fail loudly until discovery picks a vendor.
      organizer: new ManualOrganizerProvider(),
    };
  }
  const reason = env.integrationsLive
    ? `missing secrets: ${missing.join(", ")}`
    : "INTEGRATIONS_LIVE is not true";
  // eslint-disable-next-line no-console
  console.log(`[integrations] MOCK mode (${reason}): using in-memory test doubles`);
  return {
    calendly: new MockCalendlyAdapter(),
    docusign: new MockDocuSignAdapter(),
    gmail: new MockGmailAdapter(),
    typeform: new MockTypeformAdapter(),
    dropbox: new MockDropboxAdapter(),
    organizer: new MockOrganizerAdapter(),
  };
}

export { UnselectedOrganizerProvider, ManualOrganizerProvider };
