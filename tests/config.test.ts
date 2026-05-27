import { describe, it, expect } from "vitest";
import { loadConfig } from "../lib/config";

const key32Hex = "a".repeat(64); // 32 bytes in hex

function fullEnv(): Record<string, string> {
  return {
    APP_ID: "123",
    APP_PRIVATE_KEY: "-----BEGIN KEY-----\\nabc\\n-----END KEY-----",
    WEBHOOK_SECRET: "whsec",
    ENCRYPTION_KEY: key32Hex,
    SETUP_ACCESS_CODE: "code",
  };
}

describe("loadConfig", () => {
  it("loads required values and applies defaults", () => {
    const cfg = loadConfig(fullEnv());
    expect(cfg.appId).toBe("123");
    expect(cfg.webhookSecret).toBe("whsec");
    expect(cfg.setupAccessCode).toBe("code");
    expect(cfg.encryptionKey.length).toBe(32);
    expect(cfg.protectedBranches).toEqual(["main", "master"]);
    expect(cfg.triggerMention).toBe("pr-approver-bot");
  });

  it("un-escapes \\n in the private key", () => {
    const cfg = loadConfig(fullEnv());
    expect(cfg.appPrivateKey).toContain("\n");
    expect(cfg.appPrivateKey).not.toContain("\\n");
  });

  it("parses overrides", () => {
    const cfg = loadConfig({
      ...fullEnv(),
      PROTECTED_BRANCHES: "main, release/*, develop",
      TRIGGER_MENTION: "@My-Bot",
    });
    expect(cfg.protectedBranches).toEqual(["main", "release/*", "develop"]);
    expect(cfg.triggerMention).toBe("my-bot");
  });

  it("throws when a required var is missing", () => {
    const env = fullEnv();
    delete env.WEBHOOK_SECRET;
    expect(() => loadConfig(env)).toThrow(/WEBHOOK_SECRET/);
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
