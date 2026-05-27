export interface Config {
  webhookSecret: string;
  encryptionKey: Buffer;
  setupAccessCode: string;
  botPat: string;
  protectedBranches: string[];
  triggerKeyword: string;
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

  return {
    webhookSecret: required(env, "WEBHOOK_SECRET"),
    encryptionKey: parseKey(required(env, "ENCRYPTION_KEY")),
    setupAccessCode: required(env, "SETUP_ACCESS_CODE"),
    botPat: required(env, "BOT_PAT"),
    protectedBranches: protectedRaw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    triggerKeyword: (env.TRIGGER_KEYWORD ?? "/approve-as").trim(),
  };
}
