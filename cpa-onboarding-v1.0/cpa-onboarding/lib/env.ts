/**
 * Typed, lazy access to environment variables. No hardcoded secrets anywhere.
 * `req()` throws only when the value is actually read, so `next build` and
 * unit tests that don't touch a secret keep working.
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  get databaseUrl() {
    return req("DATABASE_URL");
  },
  get googleClientId() {
    return req("GOOGLE_CLIENT_ID");
  },
  get firmDomain() {
    return req("FIRM_DOMAIN");
  },
  get sessionSecret() {
    return req("SESSION_SECRET");
  },
  /** "staff" serves the UI behind IAP; "webhooks" serves only the public ingress. */
  get serviceRole() {
    return opt("SERVICE_ROLE", "staff");
  },
  get nodeEnv() {
    return opt("NODE_ENV", "development");
  },
  get isProd() {
    return opt("NODE_ENV", "development") === "production";
  },
  // Integration secrets (Secret Manager in prod; .env.local in dev only)
  get calendlySigningKey() {
    return opt("CALENDLY_SIGNING_KEY");
  },
  get typeformSecret() {
    return opt("TYPEFORM_SECRET");
  },
  get docusign() {
    return {
      integrationKey: opt("DOCUSIGN_INTEGRATION_KEY"),
      rsaPrivateKey: opt("DOCUSIGN_RSA_PRIVATE_KEY"),
      userId: opt("DOCUSIGN_USER_ID"),
      accountId: opt("DOCUSIGN_ACCOUNT_ID"),
      authHost: opt("DOCUSIGN_AUTH_HOST", "account-d.docusign.com"),
      templateId: opt("DOCUSIGN_TEMPLATE_ID"),
      connectHmacKey: opt("DOCUSIGN_CONNECT_HMAC_KEY"),
    };
  },
  /** True when this runtime is allowed to call real vendor APIs. */
  get integrationsLive() {
    return opt("INTEGRATIONS_LIVE", "false") === "true";
  },
};
