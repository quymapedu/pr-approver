import { describe, it, expect } from "vitest";
import { extractMentions, containsKeyword } from "../lib/parse";

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

describe("containsKeyword", () => {
  it("is true when the keyword is present (case-insensitive)", () => {
    expect(containsKeyword("please /Approve-As @bob", "/approve-as")).toBe(true);
  });

  it("is false when the keyword is absent", () => {
    expect(containsKeyword("just chatting @bob", "/approve-as")).toBe(false);
  });

  it("ignores the keyword inside inline code", () => {
    expect(containsKeyword("docs say `/approve-as` does X", "/approve-as")).toBe(false);
  });
});
