import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifySlackSignature,
  parsePrUrl,
  parseSlackUserIds,
} from "../lib/slack";

const secret = "shh";
const body = "command=/approve-as&text=hi";
const ts = Math.floor(Date.now() / 1000).toString();
const goodSig =
  "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");

describe("verifySlackSignature", () => {
  it("accepts a valid signature", () => {
    expect(verifySlackSignature(body, ts, goodSig, secret)).toBe(true);
  });
  it("rejects a wrong signature", () => {
    expect(verifySlackSignature(body, ts, "v0=deadbeef", secret)).toBe(false);
  });
  it("rejects a missing header", () => {
    expect(verifySlackSignature(body, ts, null, secret)).toBe(false);
    expect(verifySlackSignature(body, null, goodSig, secret)).toBe(false);
  });
  it("rejects a stale timestamp (replay)", () => {
    const oldTs = (Math.floor(Date.now() / 1000) - 60 * 10).toString();
    const sig =
      "v0=" +
      createHmac("sha256", secret).update(`v0:${oldTs}:${body}`).digest("hex");
    expect(verifySlackSignature(body, oldTs, sig, secret)).toBe(false);
  });
});

describe("parsePrUrl", () => {
  it("extracts owner/repo/number from a PR URL in the text", () => {
    expect(parsePrUrl("approve https://github.com/org/repo/pull/123 please")).toEqual(
      { owner: "org", repo: "repo", number: 123 },
    );
  });
  it("returns null when no PR URL is present", () => {
    expect(parsePrUrl("nothing here")).toBeNull();
  });
});

describe("parseSlackUserIds", () => {
  it("extracts unique Slack user IDs from escaped mentions", () => {
    expect(parseSlackUserIds("<@U1|alice> and <@U2> and <@U1>")).toEqual([
      "U1",
      "U2",
    ]);
  });
  it("returns [] when there are no mentions", () => {
    expect(parseSlackUserIds("just text")).toEqual([]);
  });
});
