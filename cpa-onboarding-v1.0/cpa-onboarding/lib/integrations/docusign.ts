import { createHmac, timingSafeEqual } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import type { DocuSignAdapter } from "./types";
import { env } from "../env";

/**
 * Verify a DocuSign Connect webhook signature against raw request bytes.
 * Header `X-DocuSign-Signature-1` = Base64(HMAC-SHA256(raw body, HMAC key)).
 * Returns false (never throws) on missing/invalid header.
 */
export function verifyDocuSignConnectSignature(
  rawBody: Buffer,
  header: string,
  key: string,
): boolean {
  if (!header || !key) return false;
  const expected = createHmac("sha256", key).update(rawBody).digest("base64");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header.trim(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const JWT_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const TOKEN_CACHE_MS = 55 * 60 * 1000; // cache ~55 min; DocuSign tokens live ~60 min

export interface DocuSignConfig {
  integrationKey: string;
  rsaPrivateKey: string;
  userId: string;
  accountId: string;
  authHost: string;
  /** eSignature REST base URI, e.g. https://demo.docusign.net/restapi (demo). */
  baseUri: string;
}

function defaultConfig(): DocuSignConfig {
  const d = env.docusign;
  return {
    integrationKey: d.integrationKey,
    rsaPrivateKey: d.rsaPrivateKey,
    userId: d.userId,
    accountId: d.accountId,
    authHost: d.authHost,
    // Base URI comes from /oauth/userinfo at runtime; the default below only
    // covers the demo host. Prod must supply DOCUSIGN_BASE_URI (wired by
    // workstream b from Secret Manager).
    baseUri:
      process.env["DOCUSIGN_BASE_URI"] ??
      (d.authHost.includes("-d.") ? "https://demo.docusign.net/restapi" : ""),
  };
}

/**
 * Real DocuSign adapter (eSignature REST v2.1, JWT Grant auth).
 * NOT live-verified: no DocuSign console is reachable from this environment.
 */
export class RealDocuSignAdapter implements DocuSignAdapter {
  private cfg: DocuSignConfig;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(cfg?: Partial<DocuSignConfig>) {
    this.cfg = { ...defaultConfig(), ...cfg };
  }

  private requireConfigured(): DocuSignConfig {
    const c = this.cfg;
    for (const [k, v] of Object.entries({
      integrationKey: c.integrationKey,
      rsaPrivateKey: c.rsaPrivateKey,
      userId: c.userId,
      accountId: c.accountId,
      authHost: c.authHost,
    })) {
      if (!v) throw new Error(`DocuSign not configured: missing ${k}`);
    }
    return c;
  }

  async getToken(): Promise<string> {
    const c = this.requireConfigured();
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) return this.cachedToken;
    const privateKey = await importPKCS8(c.rsaPrivateKey, "RS256");
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: "signature impersonation" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(c.integrationKey)
      .setSubject(c.userId)
      .setAudience(c.authHost)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);
    const res = await fetch(`https://${c.authHost}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: JWT_GRANT_TYPE,
        assertion,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DocuSign token exchange failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token) throw new Error("DocuSign token exchange returned no access_token");
    this.cachedToken = data.access_token;
    this.tokenExpiresAt = Date.now() + TOKEN_CACHE_MS;
    return this.cachedToken;
  }

  async createEnvelopeFromTemplate(input: {
    templateId: string;
    clientEmail: string;
    clientName: string;
    roleName: string;
    tabValues: Record<string, string>;
  }): Promise<{ envelopeId: string }> {
    const c = this.requireConfigured();
    if (!c.baseUri) throw new Error("DocuSign not configured: missing baseUri (DOCUSIGN_BASE_URI)");
    const token = await this.getToken();
    const textTabs = Object.entries(input.tabValues).map(([tabLabel, value]) => ({
      tabLabel,
      value,
    }));
    const body = {
      status: "sent",
      templateId: input.templateId,
      emailSubject: "Please sign your engagement letter",
      templateRoles: [
        {
          email: input.clientEmail,
          name: input.clientName,
          roleName: input.roleName,
          // NOTE: clientUserId is deliberately OMITTED — remote email signing.
          tabs: { textTabs },
        },
      ],
    };
    const res = await fetch(`${c.baseUri}/v2.1/accounts/${c.accountId}/envelopes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DocuSign envelope create failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as { envelopeId?: string };
    if (!data.envelopeId) throw new Error("DocuSign envelope create returned no envelopeId");
    return { envelopeId: data.envelopeId };
  }

  async getEnvelopeStatus(envelopeId: string): Promise<{ status: string }> {
    const c = this.requireConfigured();
    if (!c.baseUri) throw new Error("DocuSign not configured: missing baseUri (DOCUSIGN_BASE_URI)");
    const token = await this.getToken();
    const res = await fetch(`${c.baseUri}/v2.1/accounts/${c.accountId}/envelopes/${encodeURIComponent(envelopeId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DocuSign status check failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { status?: string };
    return { status: String(data.status ?? "") };
  }

  async downloadCombined(envelopeId: string): Promise<Buffer> {
    const c = this.requireConfigured();
    if (!c.baseUri) throw new Error("DocuSign not configured: missing baseUri (DOCUSIGN_BASE_URI)");
    const token = await this.getToken();
    const res = await fetch(
      `${c.baseUri}/v2.1/accounts/${c.accountId}/envelopes/${encodeURIComponent(envelopeId)}/documents/combined`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DocuSign document download failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  verifyConnectSignature(rawBody: Buffer, header: string, key: string): boolean {
    return verifyDocuSignConnectSignature(rawBody, header, key);
  }
}
