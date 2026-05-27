import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";

const mem = new Map<string, string>(); // login -> ciphertext
const links = new Map<string, string>(); // slack_user_id -> login

// Minimal in-memory stand-in for Neon's direct-call form sql(text, params) -> rows[].
const query = vi.fn(async (text: string, params: unknown[] = []) => {
  if (text.includes("INSERT INTO pats")) {
    mem.set(params[0] as string, params[1] as string);
    return [];
  }
  if (text.includes("SELECT ciphertext FROM pats")) {
    const v = mem.get(params[0] as string);
    return v ? [{ ciphertext: v }] : [];
  }
  if (text.includes("DELETE FROM pats")) {
    mem.delete(params[0] as string);
    return [];
  }
  if (text.includes("SELECT login FROM pats")) {
    return [...mem.keys()].map((login) => ({ login }));
  }
  if (text.includes("INSERT INTO slack_links")) {
    links.set(params[0] as string, params[1] as string);
    return [];
  }
  if (text.includes("SELECT login FROM slack_links")) {
    const v = links.get(params[0] as string);
    return v ? [{ login: v }] : [];
  }
  if (text.includes("DELETE FROM slack_links")) {
    links.delete(params[0] as string);
    return [];
  }
  throw new Error(`unexpected query: ${text}`);
});

vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn(() => query),
}));

import {
  putPat,
  getPat,
  delPat,
  listLogins,
  putSlackLink,
  getLoginForSlack,
  delSlackLink,
} from "../lib/store";

const key = randomBytes(32);

describe("store", () => {
  beforeEach(() => {
    mem.clear();
    links.clear();
  });

  it("stores and retrieves a PAT (encrypted at rest)", async () => {
    await putPat("Bob", "ghp_token", key);
    // stored value is ciphertext, not the raw token
    expect(mem.get("bob")).toBeDefined();
    expect(mem.get("bob")).not.toContain("ghp_token");
    expect(await getPat("bob", key)).toBe("ghp_token");
  });

  it("normalizes login to lowercase", async () => {
    await putPat("Carol", "ghp_c", key);
    expect(await getPat("CAROL", key)).toBe("ghp_c");
  });

  it("upserts on duplicate login", async () => {
    await putPat("bob", "ghp_old", key);
    await putPat("bob", "ghp_new", key);
    expect(await getPat("bob", key)).toBe("ghp_new");
    expect(mem.size).toBe(1);
  });

  it("returns null for an unknown login", async () => {
    expect(await getPat("nobody", key)).toBeNull();
  });

  it("removes a PAT", async () => {
    await putPat("dan", "ghp_d", key);
    await delPat("Dan");
    expect(await getPat("dan", key)).toBeNull();
  });

  it("lists registered logins", async () => {
    await putPat("bob", "x", key);
    await putPat("carol", "y", key);
    expect((await listLogins()).sort()).toEqual(["bob", "carol"]);
  });

  it("stores and retrieves a Slack→login link (login lowercased)", async () => {
    await putSlackLink("U123", "Bob");
    expect(await getLoginForSlack("U123")).toBe("bob");
  });

  it("upserts a Slack link", async () => {
    await putSlackLink("U123", "bob");
    await putSlackLink("U123", "carol");
    expect(await getLoginForSlack("U123")).toBe("carol");
    expect(links.size).toBe(1);
  });

  it("returns null for an unknown Slack user", async () => {
    expect(await getLoginForSlack("Unope")).toBeNull();
  });

  it("removes a Slack link", async () => {
    await putSlackLink("U123", "bob");
    await delSlackLink("U123");
    expect(await getLoginForSlack("U123")).toBeNull();
  });
});
