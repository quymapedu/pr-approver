import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifySlackSignature,
  parsePrRef,
  parseSlackUserIds,
} from "../lib/slack";

const OWNER = "mapEDU-AI";

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

describe("parsePrRef", () => {
  it("parses a full PR URL with its own owner/repo", () => {
    expect(parsePrRef("approve https://github.com/org/repo/pull/123 please", OWNER)).toEqual(
      { owner: "org", repo: "repo", number: 123 },
    );
  });
  it("parses a scheme-less github.com URL", () => {
    expect(parsePrRef("github.com/org/repo/pull/9", OWNER)).toEqual(
      { owner: "org", repo: "repo", number: 9 },
    );
  });
  it("parses owner/repo/pull/n", () => {
    expect(parsePrRef("mapEDU-AI/mapedu-be/pull/1164", OWNER)).toEqual(
      { owner: "mapEDU-AI", repo: "mapedu-be", number: 1164 },
    );
  });
  it("parses repo/pull/n using the default owner", () => {
    expect(parsePrRef("mapedu-be/pull/1164", OWNER)).toEqual(
      { owner: OWNER, repo: "mapedu-be", number: 1164 },
    );
  });
  it("parses repo#n using the default owner", () => {
    expect(parsePrRef("mapedu-fe#42", OWNER)).toEqual(
      { owner: OWNER, repo: "mapedu-fe", number: 42 },
    );
  });
  it("parses a bare number as repo:null with the default owner", () => {
    expect(parsePrRef("1164", OWNER)).toEqual(
      { owner: OWNER, repo: null, number: 1164 },
    );
  });
  it("parses a #-prefixed bare number", () => {
    expect(parsePrRef("approve #1164 please", OWNER)).toEqual(
      { owner: OWNER, repo: null, number: 1164 },
    );
  });
  it("ignores digits inside Slack mention tokens", () => {
    expect(parsePrRef("<@U01BOB> please review mapedu-be/pull/7", OWNER)).toEqual(
      { owner: OWNER, repo: "mapedu-be", number: 7 },
    );
  });
  it("does not treat a Slack user id as a bare PR number", () => {
    expect(parsePrRef("<@U01BOB> hi", OWNER)).toBeNull();
  });
  it("returns null when no PR reference is present", () => {
    expect(parsePrRef("nothing here", OWNER)).toBeNull();
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
