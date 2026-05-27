import { describe, it, expect } from "vitest";
import { loadConfig } from "../lib/config";

const key32Hex = "a".repeat(64);

function fullEnv(): Record<string, string> {
  return {
    SLACK_SIGNING_SECRET: "slacksecret",
    BOT_PAT: "ghp_bot",
    ENCRYPTION_KEY: key32Hex,
    SETUP_ACCESS_CODE: "code",
  };
}

describe("loadConfig", () => {
  it("loads required values and applies defaults", () => {
    const cfg = loadConfig(fullEnv());
    expect(cfg.slackSigningSecret).toBe("slacksecret");
    expect(cfg.botPat).toBe("ghp_bot");
    expect(cfg.setupAccessCode).toBe("code");
    expect(cfg.encryptionKey.length).toBe(32);
    expect(cfg.protectedBranches).toEqual(["main", "master"]);
  });

  it("parses PROTECTED_BRANCHES override", () => {
    const cfg = loadConfig({
      ...fullEnv(),
      PROTECTED_BRANCHES: "main, release/*, develop",
    });
    expect(cfg.protectedBranches).toEqual(["main", "release/*", "develop"]);
  });

  it("throws when SLACK_SIGNING_SECRET is missing", () => {
    const env = fullEnv();
    delete env.SLACK_SIGNING_SECRET;
    expect(() => loadConfig(env)).toThrow(/SLACK_SIGNING_SECRET/);
  });

  it("throws when BOT_PAT is missing", () => {
    const env = fullEnv();
    delete env.BOT_PAT;
    expect(() => loadConfig(env)).toThrow(/BOT_PAT/);
  });

  it("throws on a wrong-length encryption key", () => {
    expect(() => loadConfig({ ...fullEnv(), ENCRYPTION_KEY: "short" })).toThrow(
      /ENCRYPTION_KEY/,
    );
  });

  it("accepts a base64 encryption key", () => {
    const b64 = Buffer.alloc(32, 7).toString("base64");
    const cfg = loadConfig({ ...fullEnv(), ENCRYPTION_KEY: b64 });
    expect(cfg.encryptionKey.length).toBe(32);
  });
});
