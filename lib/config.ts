export interface Config {
  slackSigningSecret: string;
  encryptionKey: Buffer;
  setupAccessCode: string;
  protectedBranches: string[];
  // Used to expand short PR references in /approve-as.
  defaultOwner: string;
  // Repos probed when the user gives a bare PR number (no repo).
  repos: string[];
}

// Org repos probed for a bare PR number, in priority order. Override with REPOS.
const DEFAULT_REPOS = [
  "mapedu-be",
  "mapedu-fe",
  "mapedu-admin",
  "mapedu-ds",
  "mapedu-content-automapper",
  "mapedu-filesearch",
  "terraform",
  "docs",
];

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
  const reposRaw = env.REPOS;

  return {
    slackSigningSecret: required(env, "SLACK_SIGNING_SECRET"),
    encryptionKey: parseKey(required(env, "ENCRYPTION_KEY")),
    setupAccessCode: required(env, "SETUP_ACCESS_CODE"),
    protectedBranches: protectedRaw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    defaultOwner: env.DEFAULT_OWNER ?? "mapEDU-AI",
    repos: reposRaw
      ? reposRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : DEFAULT_REPOS,
  };
}
