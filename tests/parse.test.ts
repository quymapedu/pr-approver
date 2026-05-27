import { describe, it, expect } from "vitest";
import { extractMentions, containsTrigger } from "../lib/parse";

describe("extractMentions", () => {
  it("extracts unique lowercased logins", () => {
    expect(extractMentions("@Bot @Alice and @alice")).toEqual([
      "bot",
      "alice",
    ]);
  });

  it("returns [] when there are no mentions", () => {
    expect(extractMentions("please review this")).toEqual([]);
  });

  it("ignores mentions inside inline code", () => {
    expect(extractMentions("use `@notauser` but ping @real")).toEqual([
      "real",
    ]);
  });

  it("ignores mentions inside fenced code blocks", () => {
    const body = "ping @real\n```\n@codeuser\n```\n";
    expect(extractMentions(body)).toEqual(["real"]);
  });

  it("strips trailing punctuation", () => {
    expect(extractMentions("hey @alice, @bob!")).toEqual(["alice", "bob"]);
  });
});

describe("containsTrigger", () => {
  it("is true when trigger login is mentioned (case-insensitive)", () => {
    expect(containsTrigger("@PR-Approver-Bot go", "pr-approver-bot")).toBe(
      true,
    );
  });

  it("is false when trigger is absent", () => {
    expect(containsTrigger("@someone-else", "pr-approver-bot")).toBe(false);
  });
});
