import { describe, it, expect } from "vitest";
import { decide } from "../lib/decide";

const base = {
  botMention: "pr-approver-bot",
  author: "alice",
  baseRef: "feature/x",
  protectedBranches: ["main", "master"],
  registeredLogins: ["bob", "carol"],
};

describe("decide", () => {
  it("approves as registered, non-author, non-bot mentions", () => {
    const r = decide({ ...base, mentions: ["pr-approver-bot", "bob", "carol"] });
    expect(r).toEqual({
      blocked: false,
      approveAs: ["bob", "carol"],
      skippedNoPat: [],
    });
  });

  it("excludes the PR author", () => {
    const r = decide({ ...base, mentions: ["pr-approver-bot", "alice", "bob"] });
    expect(r.approveAs).toEqual(["bob"]);
  });

  it("blocks protected base branch", () => {
    const r = decide({
      ...base,
      baseRef: "main",
      mentions: ["pr-approver-bot", "bob"],
    });
    expect(r).toEqual({
      blocked: true,
      blockedBranch: "main",
      approveAs: [],
      skippedNoPat: [],
    });
  });

  it("matches protected branch case-insensitively", () => {
    const r = decide({
      ...base,
      baseRef: "MAIN",
      mentions: ["pr-approver-bot", "bob"],
    });
    expect(r.blocked).toBe(true);
  });

  it("buckets mentioned-but-unregistered into skippedNoPat", () => {
    const r = decide({ ...base, mentions: ["pr-approver-bot", "bob", "dan"] });
    expect(r.approveAs).toEqual(["bob"]);
    expect(r.skippedNoPat).toEqual(["dan"]);
  });

  it("is case-insensitive on logins", () => {
    const r = decide({ ...base, mentions: ["PR-Approver-Bot", "BOB"] });
    expect(r.approveAs).toEqual(["bob"]);
  });

  it("returns empty approveAs when only the bot is mentioned", () => {
    const r = decide({ ...base, mentions: ["pr-approver-bot"] });
    expect(r.approveAs).toEqual([]);
    expect(r.skippedNoPat).toEqual([]);
  });
});
