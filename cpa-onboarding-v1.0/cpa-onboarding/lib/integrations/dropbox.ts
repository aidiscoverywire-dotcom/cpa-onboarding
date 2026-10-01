import { createHash } from "node:crypto";
import type { DropboxAdapter } from "./types";

const DROPBOX_API = "https://api.dropboxapi.com/2";

/**
 * Derive the opaque file-request reference. The client name NEVER appears in
 * the request title, URL, or logs — only this truncated SHA-256-derived
 * reference, keeping the link possession-based and PII-free (BUILD_BRIEF §5).
 */
export function fileRequestRef(clientName: string, year: number): string {
  return (
    "FR-" +
    createHash("sha256")
      .update(`${clientName}|${year}`, "utf8")
      .digest("hex")
      .slice(0, 12)
      .toUpperCase()
  );
}

/**
 * Real Dropbox adapter — per-client/per-year file requests with expiry.
 *
 * The OAuth access token is injected via the constructor (in prod: a
 * Secret Manager entry, read by workstream b — `lib/env.ts` is owned by the
 * parent orchestrator, so the caller passes it in). Never hardcoded.
 *
 * NOT live-verified: no Dropbox console is reachable from this environment.
 * The `deadline` field shape follows Dropbox's file_requests/create_v2
 * contract (deadline timestamp + late-upload policy); treat exact enum
 * values as unverified until exercised against the real API.
 */
export class RealDropboxAdapter implements DropboxAdapter {
  constructor(
    private readonly accessToken: string =
      process.env["DROPBOX_ACCESS_TOKEN"] ?? "",
  ) {
    if (!this.accessToken)
      throw new Error(
        "RealDropboxAdapter requires an access token (pass it in, or set DROPBOX_ACCESS_TOKEN from Secret Manager)",
      );
  }

  async createFileRequest(input: {
    clientName: string;
    year: number;
    expiresAt: string;
  }): Promise<{ url: string; requestId: string }> {
    const ref = fileRequestRef(input.clientName, input.year);
    const res = await fetch(`${DROPBOX_API}/file_requests/create_v2`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: `Client documents ${input.year} — ${ref}`,
        destination: `/${ref}`,
        deadline: { deadline: input.expiresAt, allow_late_uploads: "seven_days" },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Dropbox file request failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { url?: string; id?: string };
    if (!data.url || !data.id)
      throw new Error("Dropbox file request returned no url/id");
    return { url: data.url, requestId: data.id };
  }
}
