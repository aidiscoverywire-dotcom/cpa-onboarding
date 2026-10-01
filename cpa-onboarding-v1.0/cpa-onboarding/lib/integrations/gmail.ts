import type { GmailAdapter } from "./types";

/**
 * DELIBERATE DESIGN DECISION — READ BEFORE EDITING:
 *
 * This adapter creates Gmail DRAFTS ONLY (`POST /gmail/v1/users/me/drafts`,
 * scope `gmail.compose`). A staff member reviews each draft and sends it
 * manually from Gmail.
 *
 * `gmail.users.drafts.send` and `gmail.users.messages.send` MUST NEVER be
 * called from automation. That is the binding firm policy (BUILD_BRIEF §1/§5:
 * "Nothing is ever sent to clients automatically"). Adding a send path here
 * is a policy violation and must be rejected in review.
 *
 * OAuth: per-user OAuth — the access token is passed into the adapter
 * constructor by the caller (workstream b). This module never stores, caches,
 * or logs tokens; refresh-token storage (encrypted) is workstream b's
 * documented decision.
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";

/** Build a minimal RFC2822 message with an HTML body, base64url-encoded. */
export function buildRfc2822Base64Url(input: {
  to: string;
  subject: string;
  html: string;
}): string {
  const lines = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    input.html,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Real Gmail adapter — drafts.create only. NOT live-verified in this environment. */
export class RealGmailAdapter implements GmailAdapter {
  /** Per-user OAuth access token, supplied by the caller; never persisted here. */
  constructor(private readonly accessToken: string) {
    if (!accessToken) throw new Error("RealGmailAdapter requires a per-user OAuth access token");
  }

  async createDraft(input: {
    to: string;
    subject: string;
    html: string;
    threadId?: string;
  }): Promise<{ draftId: string }> {
    const message = {
      raw: buildRfc2822Base64Url(input),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    };
    const res = await fetch(`${GMAIL_API}/users/me/drafts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gmail draft create failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error("Gmail draft create returned no id");
    return { draftId: data.id };
  }

  // NOTE: there is intentionally NO send() method here. See the design
  // decision at the top of this file.
}
