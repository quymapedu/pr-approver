export interface Config {
  appId: string;
  appPrivateKey: string;
  webhookSecret: string;
  encryptionKey: Buffer;
  setupAccessCode: string;
  protectedBranches: string[];
  triggerMention: string;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function parseKey(raw: string): Buffer {
  // Accept 64-char hex or base64; must decode to exactly 32 bytes.
  let buf: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, "hex");
  else buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("ENCRYPTION_KEY must decode to 32 bytes (hex or base64)");
  }
  return buf;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  const protectedRaw = env.PROTECTED_BRANCHES ?? "main,master";
  const trigger = (env.TRIGGER_MENTION ?? "pr-approver-bot").replace(/^@/, "");

  return {
    appId: required(env, "APP_ID"),
    appPrivateKey: required(env, "APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
    webhookSecret: required(env, "WEBHOOK_SECRET"),
    encryptionKey: parseKey(required(env, "ENCRYPTION_KEY")),
    setupAccessCode: required(env, "SETUP_ACCESS_CODE"),
    protectedBranches: protectedRaw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    triggerMention: trigger.toLowerCase(),
  };
}
