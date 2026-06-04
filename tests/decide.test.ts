import { describe, it, expect } from "vitest";
import { decide } from "../lib/decide";

const base = {
  author: "alice",
  baseRef: "feature/x",
  protectedBranches: ["main", "master"],
  registeredLogins: ["bob", "carol"],
};

describe("decide", () => {
  it("approves as registered, non-author mentions", () => {
    const r = decide({ ...base, mentions: ["bob", "carol"] });
    expect(r).toEqual({
      blocked: false,
      approveAs: ["bob", "carol"],
      skippedNoPat: [],
    });
  });

  it("excludes the PR author", () => {
    const r = decide({ ...base, mentions: ["alice", "bob"] });
    expect(r.approveAs).toEqual(["bob"]);
  });

  it("blocks protected base branch", () => {
    const r = decide({
      ...base,
      baseRef: "main",
      mentions: ["bob"],
    });
    expect(r).toEqual({
      blocked: true,
      blockedBranch: "main",
      approveAs: [],
      skippedNoPat: [],
    });
  });

  it("bypasses the protected-branch block when skipProtected is set", () => {
    const r = decide({
      ...base,
      baseRef: "main",
      mentions: ["bob", "carol"],
      skipProtected: true,
    });
    expect(r).toEqual({
      blocked: false,
      approveAs: ["bob", "carol"],
      skippedNoPat: [],
    });
  });

  it("matches protected branch case-insensitively", () => {
    const r = decide({
      ...base,
      baseRef: "MAIN",
      mentions: ["bob"],
    });
    expect(r.blocked).toBe(true);
  });

  it("buckets mentioned-but-unregistered into skippedNoPat", () => {
    const r = decide({ ...base, mentions: ["bob", "dan"] });
    expect(r.approveAs).toEqual(["bob"]);
    expect(r.skippedNoPat).toEqual(["dan"]);
  });

  it("is case-insensitive on logins", () => {
    const r = decide({ ...base, mentions: ["BOB"] });
    expect(r.approveAs).toEqual(["bob"]);
  });

  it("returns empty approveAs when no one eligible is mentioned", () => {
    const r = decide({ ...base, mentions: [] });
    expect(r.approveAs).toEqual([]);
    expect(r.skippedNoPat).toEqual([]);
  });
});
