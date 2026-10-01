import { describe, expect, it } from "vitest";
import {
  REDACTED_ACCOUNT,
  REDACTED_EIN,
  REDACTED_SSN,
  redactPII,
  redactPIIText,
} from "./redact";

describe("redactPIIText", () => {
  it("redacts a dashed SSN", () => {
    expect(redactPIIText("SSN 123-45-6789 on file")).toBe(
      `SSN ${REDACTED_SSN} on file`,
    );
  });

  it("redacts a space-separated SSN (adversarial spacing)", () => {
    expect(redactPIIText("ssn 123 45 6789")).toBe(`ssn ${REDACTED_SSN}`);
  });

  it("redacts a bare 9-digit SSN (adversarial, no separators)", () => {
    expect(redactPIIText("id 123456789")).toBe(`id ${REDACTED_SSN}`);
  });

  it("redacts an EIN", () => {
    expect(redactPIIText("EIN 12-3456787")).toBe(`EIN ${REDACTED_EIN}`);
  });

  it("redacts a bare bank account number", () => {
    expect(redactPIIText("acct 12345678 wired")).toBe(
      `acct ${REDACTED_ACCOUNT} wired`,
    );
  });

  it("redacts a long account number", () => {
    expect(redactPIIText("acct 123456789012345")).toBe(
      `acct ${REDACTED_ACCOUNT}`,
    );
  });

  it("redacts grouped account numbers (adversarial dashes/spaces)", () => {
    expect(redactPIIText("card 1234-5678-9012-3456")).toBe(
      `card ${REDACTED_ACCOUNT}`,
    );
    expect(redactPIIText("acct 1234 5678 9012")).toBe(
      `acct ${REDACTED_ACCOUNT}`,
    );
  });

  it("redacts multiple PII values in one string", () => {
    const out = redactPIIText("SSN 123-45-6789, EIN 12-3456787, acct 9876543210");
    expect(out).toBe(
      `SSN ${REDACTED_SSN}, EIN ${REDACTED_EIN}, acct ${REDACTED_ACCOUNT}`,
    );
  });

  it("does not partially match inside a longer digit run", () => {
    // 18 digits: outside the 8-17 account window; must not carve an SSN out of it.
    const long = "991234567890123456";
    expect(redactPIIText(long)).toBe(long);
    // A 10-digit run is one account token, not an SSN + digit.
    expect(redactPIIText("n 1234567890")).toBe(`n ${REDACTED_ACCOUNT}`);
  });

  it("leaves phone numbers and dates alone", () => {
    expect(redactPIIText("call 555-123-4567 on 2026-09-30")).toBe(
      "call 555-123-4567 on 2026-09-30",
    );
  });

  it("leaves already-safe text untouched", () => {
    const s = "Client intake matched for jane@example.com";
    expect(redactPIIText(s)).toBe(s);
  });

  it("passes non-string input through unchanged", () => {
    expect(redactPIIText(undefined as unknown as string)).toBe(undefined);
  });
});

describe("redactPII (deep)", () => {
  it("redacts nested objects and arrays, preserving shape", () => {
    const input = {
      ssn: "123-45-6789",
      nested: { ein: "EIN 12-3456787", ok: "hello" },
      list: ["acct 12345678", 42, null],
    };
    expect(redactPII(input)).toEqual({
      ssn: REDACTED_SSN,
      nested: { ein: `EIN ${REDACTED_EIN}`, ok: "hello" },
      list: [`acct ${REDACTED_ACCOUNT}`, 42, null],
    });
    // input not mutated
    expect(input.ssn).toBe("123-45-6789");
  });

  it("passes null/numbers/booleans through", () => {
    expect(redactPII(null)).toBe(null);
    expect(redactPII(42)).toBe(42);
    expect(redactPII(true)).toBe(true);
  });
});
