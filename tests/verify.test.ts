import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySignature } from "../lib/verify";

const secret = "test-secret";
const body = '{"hello":"world"}';
const goodSig =
  "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

describe("verifySignature", () => {
  it("accepts a valid signature", () => {
    expect(verifySignature(body, goodSig, secret)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    expect(verifySignature(body, "sha256=deadbeef", secret)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifySignature(body, null, secret)).toBe(false);
  });

  it("rejects a tampered body", () => {
    expect(verifySignature(body + " ", goodSig, secret)).toBe(false);
  });
});
