/**
 * PII redaction for audit snapshots and logs.
 *
 * Binding per BUILD_BRIEF §7: audit snapshots must be PII-safe so WORM
 * retention of `audit_events` never conflicts with secure disposal.
 * Every audit before/after snapshot passes through `redactPII` before it is
 * written — redaction happens in `lib/audit.ts` (`appendAudit`).
 *
 * Tokens:
 *   [REDACTED_SSN]     — US Social Security Number (dashed, spaced, or bare 9-digit)
 *   [REDACTED_EIN]     — US Employer Identification Number (XX-XXXXXXX)
 *   [REDACTED_ACCOUNT] — bank-account-like numbers (8+ digits, grouped or bare)
 *
 * Deliberately NOT redacted here: phone numbers, names, email addresses
 * (kept for audit usefulness; the brief names SSN/EIN/bank accounts).
 */

export const REDACTED_SSN = "[REDACTED_SSN]";
export const REDACTED_EIN = "[REDACTED_EIN]";
export const REDACTED_ACCOUNT = "[REDACTED_ACCOUNT]";

/**
 * Single-pass alternation, most-specific first. Word boundaries keep a match
 * from firing inside a longer digit run (e.g. the first 9 digits of a
 * 16-digit card number are NOT treated as an SSN).
 */
const PII_PATTERN = new RegExp(
  [
    String.raw`\b\d{3}-\d{2}-\d{4}\b`, // SSN dashed: 123-45-6789
    String.raw`\b\d{3} \d{2} \d{4}\b`, // SSN spaced: 123 45 6789
    String.raw`\b\d{2}-\d{7}\b`, // EIN: 12-3456787
    String.raw`\b\d{4}(?:[- ]\d{4}){2,3}\b`, // grouped account: 1234-5678-9012[-3456]
    String.raw`\b\d{9}\b`, // bare 9-digit run (SSN without separators)
    String.raw`\b\d{8}\b`, // 8-digit run (short account)
    String.raw`\b\d{10,17}\b`, // 10-17 digit run (account / routing+account)
  ].join("|"),
  "g",
);

function classify(match: string): string {
  if (/^\d{3}[- ]\d{2}[- ]\d{4}$/.test(match) || /^\d{9}$/.test(match)) {
    return REDACTED_SSN;
  }
  if (/^\d{2}-\d{7}$/.test(match)) {
    return REDACTED_EIN;
  }
  return REDACTED_ACCOUNT;
}

/** Redact PII in a plain string. Non-string input is returned unchanged. */
export function redactPIIText(input: string): string {
  if (typeof input !== "string") return input;
  return input.replace(PII_PATTERN, (m) => classify(m));
}

/**
 * Deep-redact PII in any JSON-shaped value (strings, arrays, plain objects).
 * Returns a new value with the same shape; non-plain values pass through.
 */
export function redactPII<T>(input: T): T {
  if (typeof input === "string") {
    return redactPIIText(input) as T;
  }
  if (Array.isArray(input)) {
    return input.map((v) => redactPII(v)) as T;
  }
  if (input !== null && typeof input === "object") {
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return input;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = redactPII(v);
    }
    return out as T;
  }
  return input;
}
