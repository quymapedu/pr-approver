# PR Approver Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GitHub App (on Vercel) that, when tagged in a PR comment alongside one or more reviewers, submits an approving review as each tagged reviewer using their own registered PAT — never approving PRs into protected branches.

**Architecture:** A single Vercel project with two Fetch-API serverless functions: `/api/webhook` (reacts to `issue_comment` events) and `/api/register` (backs the `/setup` self-service page). PATs are stored AES-256-GCM-encrypted in Neon (serverless Postgres), in a single `pats` table keyed by the GitHub login that `GET /user` reports for the token. Pure logic (`parse`, `decide`, `crypto`, `verify`, `config`) lives in `lib/` and is fully unit-tested; thin GitHub/DB wrappers take injectable clients so they're testable without network.

**Tech Stack:** TypeScript, Vercel Functions (Node runtime, Fetch handlers), `octokit` (App + Octokit), `@neondatabase/serverless` (HTTP driver), Node `crypto`, Vitest.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `vercel.json` | Project scaffold |
| `lib/config.ts` | Load + validate env into a typed `Config` |
| `lib/crypto.ts` | AES-256-GCM `encrypt`/`decrypt` |
| `lib/verify.ts` | HMAC-SHA256 webhook signature verification |
| `lib/parse.ts` | Extract `@mentions` / detect trigger in a comment body |
| `lib/decide.ts` | Pure decision: who to approve as / skip / blocked |
| `lib/store.ts` | Postgres-backed `login → encrypted PAT` (put/get/del/list) |
| `lib/github.ts` | Octokit helpers: app/installation/pat clients, getPR, approve, comment, whoami |
| `api/register.ts` | `/setup` backend: verify access code + PAT → upsert/remove in DB |
| `api/webhook.ts` | Webhook entry: verify, parse, orchestrate approvals |
| `public/setup.html` | Static paste-PAT form |
| `README.md` | Setup steps |

Login strings are normalized to **lowercase** everywhere (GitHub logins are case-insensitive). The trigger mention is stored/compared **without** the leading `@`.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `vercel.json`
- Test: `tests/smoke.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "pr-approver",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@neondatabase/serverless": "^0.10.0",
    "octokit": "^4.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true
  },
  "include": ["lib", "api", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules
.vercel
.env
.env.*
*.log
```

- [ ] **Step 5: Create `vercel.json`**

```json
{
  "functions": {
    "api/*.ts": {
      "runtime": "@vercel/node@5.1.0"
    }
  }
}
```

- [ ] **Step 6: Create `tests/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";

describe("smoke", () => {
  it("runs vitest", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 7: Install and run the smoke test**

Run: `npm install && npm test`
Expected: 1 test file, 1 test passing.

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore vercel.json tests/smoke.test.ts package-lock.json
git commit -m "chore: scaffold TypeScript + Vitest project"
```

---

### Task 2: `lib/crypto.ts` — AES-256-GCM

**Files:**
- Create: `lib/crypto.ts`
- Test: `tests/crypto.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "../lib/crypto";

const key = randomBytes(32);

describe("crypto", () => {
  it("round-trips plaintext", () => {
    const out = decrypt(encrypt("ghp_secret", key), key);
    expect(out).toBe("ghp_secret");
  });

  it("produces different ciphertext each call (random IV)", () => {
    expect(encrypt("x", key)).not.toBe(encrypt("x", key));
  });

  it("rejects tampered ciphertext", () => {
    const enc = encrypt("ghp_secret", key);
    const bytes = Buffer.from(enc, "base64");
    bytes[bytes.length - 1] ^= 0xff; // flip a byte in the ciphertext/tag
    expect(() => decrypt(bytes.toString("base64"), key)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/crypto.test.ts`
Expected: FAIL — cannot find `encrypt`/`decrypt`.

- [ ] **Step 3: Write the implementation**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LEN = 12;
const TAG_LEN = 16;

// Layout: base64( iv[12] | authTag[16] | ciphertext )
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decrypt(payload: string, key: Buffer): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/crypto.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/crypto.ts tests/crypto.test.ts
git commit -m "feat: AES-256-GCM encrypt/decrypt for PAT storage"
```

---

### Task 3: `lib/verify.ts` — webhook signature

**Files:**
- Create: `lib/verify.ts`
- Test: `tests/verify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySignature } from "../lib/verify";

const secret = "test-secret";
const body = '{"hello":"world"}';
const goodSig =
  "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

describe("verifySignature", () => {
  it("accepts a valid signature", () => {
    expect(verifySignature(body, goodSig, secret)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    expect(verifySignature(body, "sha256=deadbeef", secret)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifySignature(body, null, secret)).toBe(false);
  });

  it("rejects a tampered body", () => {
    expect(verifySignature(body + " ", goodSig, secret)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/verify.test.ts`
Expected: FAIL — cannot find `verifySignature`.

- [ ] **Step 3: Write the implementation**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected =
    "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/verify.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/verify.ts tests/verify.test.ts
git commit -m "feat: HMAC-SHA256 webhook signature verification"
```

---

### Task 4: `lib/parse.ts` — mention extraction

**Files:**
- Create: `lib/parse.ts`
- Test: `tests/parse.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/parse.test.ts`
Expected: FAIL — cannot find `extractMentions`/`containsTrigger`.

- [ ] **Step 3: Write the implementation**

```ts
// GitHub logins: 1-39 chars, alphanumeric or single hyphens.
const MENTION_RE = /@([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})/gi;

function stripCode(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ") // fenced blocks
    .replace(/`[^`]*`/g, " "); // inline code
}

export function extractMentions(body: string): string[] {
  const text = stripCode(body);
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const login = m[1].toLowerCase();
    if (!out.includes(login)) out.push(login);
  }
  return out;
}

export function containsTrigger(body: string, trigger: string): boolean {
  return extractMentions(body).includes(trigger.toLowerCase());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/parse.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/parse.ts tests/parse.test.ts
git commit -m "feat: parse @mentions and trigger from comment body"
```

---

### Task 5: `lib/decide.ts` — pure decision logic

**Files:**
- Create: `lib/decide.ts`
- Test: `tests/decide.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decide.test.ts`
Expected: FAIL — cannot find `decide`.

- [ ] **Step 3: Write the implementation**

```ts
export interface DecideInput {
  mentions: string[];
  botMention: string;
  author: string;
  baseRef: string;
  protectedBranches: string[];
  registeredLogins: string[];
}

export interface DecideResult {
  blocked: boolean;
  blockedBranch?: string;
  approveAs: string[];
  skippedNoPat: string[];
}

export function decide(input: DecideInput): DecideResult {
  const lc = (s: string) => s.toLowerCase();
  const bot = lc(input.botMention);
  const author = lc(input.author);
  const base = lc(input.baseRef);
  const protectedBranches = input.protectedBranches.map(lc);
  const registered = new Set(input.registeredLogins.map(lc));

  if (protectedBranches.includes(base)) {
    return {
      blocked: true,
      blockedBranch: input.baseRef,
      approveAs: [],
      skippedNoPat: [],
    };
  }

  const candidates: string[] = [];
  for (const m of input.mentions.map(lc)) {
    if (m === bot || m === author) continue;
    if (!candidates.includes(m)) candidates.push(m);
  }

  const approveAs: string[] = [];
  const skippedNoPat: string[] = [];
  for (const c of candidates) {
    if (registered.has(c)) approveAs.push(c);
    else skippedNoPat.push(c);
  }

  return { blocked: false, approveAs, skippedNoPat };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/decide.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/decide.ts tests/decide.test.ts
git commit -m "feat: pure approve/skip/block decision logic"
```

---

### Task 6: `lib/config.ts` — env loading & validation

**Files:**
- Create: `lib/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot find `loadConfig`.

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/config.ts tests/config.test.ts
git commit -m "feat: typed env config loader with validation"
```

---

### Task 7: `lib/store.ts` — Postgres-backed PAT store

**Files:**
- Create: `lib/store.ts`
- Test: `tests/store.test.ts`

The store talks to Neon via `db().query(text, params)`. Tests mock
`@neondatabase/serverless` with an in-memory `query()` that interprets the SQL,
so no network/database is needed. The table is
`pats(login text primary key, ciphertext text not null)` (created once in Neon —
see Task 12).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";

const mem = new Map<string, string>(); // login -> ciphertext

// Minimal in-memory stand-in for Neon's sql.query(text, params) -> rows[].
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
  throw new Error(`unexpected query: ${text}`);
});

vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn(() => ({ query })),
}));

import { putPat, getPat, delPat, listLogins } from "../lib/store";

const key = randomBytes(32);

describe("store", () => {
  beforeEach(() => mem.clear());

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — cannot find `putPat` etc.

- [ ] **Step 3: Write the implementation**

```ts
import { neon } from "@neondatabase/serverless";
import { encrypt, decrypt } from "./crypto";

const norm = (login: string) => login.toLowerCase();

// Lazily create one HTTP client per cold start.
let _sql: ReturnType<typeof neon> | null = null;
function db() {
  return (_sql ??= neon(process.env.DATABASE_URL!));
}

export async function putPat(
  login: string,
  pat: string,
  key: Buffer,
): Promise<void> {
  await db().query(
    `INSERT INTO pats (login, ciphertext) VALUES ($1, $2)
     ON CONFLICT (login) DO UPDATE SET ciphertext = EXCLUDED.ciphertext`,
    [norm(login), encrypt(pat, key)],
  );
}

export async function getPat(
  login: string,
  key: Buffer,
): Promise<string | null> {
  const rows = (await db().query(
    `SELECT ciphertext FROM pats WHERE login = $1`,
    [norm(login)],
  )) as { ciphertext: string }[];
  return rows[0] ? decrypt(rows[0].ciphertext, key) : null;
}

export async function delPat(login: string): Promise<void> {
  await db().query(`DELETE FROM pats WHERE login = $1`, [norm(login)]);
}

export async function listLogins(): Promise<string[]> {
  const rows = (await db().query(`SELECT login FROM pats`)) as {
    login: string;
  }[];
  return rows.map((r) => r.login);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/store.ts tests/store.test.ts
git commit -m "feat: Neon Postgres-backed encrypted PAT store"
```

---

### Task 8: `lib/github.ts` — Octokit helpers

**Files:**
- Create: `lib/github.ts`
- Test: `tests/github.test.ts`

Helpers that build clients (`makeApp`, `getInstallationClient`, `clientForToken`) are thin and exercised in integration; the data-shaping helpers take an injected client and are unit-tested with a fake.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import {
  getPullRequest,
  approve,
  postComment,
  getAuthenticatedLogin,
} from "../lib/github";

function fakeClient() {
  return {
    rest: {
      pulls: {
        get: vi.fn(async () => ({
          data: { user: { login: "Alice" }, base: { ref: "feature/x" } },
        })),
        createReview: vi.fn(async () => ({ data: {} })),
      },
      issues: { createComment: vi.fn(async () => ({ data: {} })) },
      users: {
        getAuthenticated: vi.fn(async () => ({ data: { login: "Bob" } })),
      },
    },
  };
}

describe("github helpers", () => {
  it("getPullRequest returns author + baseRef", async () => {
    const c = fakeClient();
    const pr = await getPullRequest(c as any, "o", "r", 5);
    expect(pr).toEqual({ author: "Alice", baseRef: "feature/x" });
    expect(c.rest.pulls.get).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      pull_number: 5,
    });
  });

  it("approve submits an APPROVE review", async () => {
    const c = fakeClient();
    await approve(c as any, "o", "r", 5);
    expect(c.rest.pulls.createReview).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      pull_number: 5,
      event: "APPROVE",
    });
  });

  it("postComment posts to the issue", async () => {
    const c = fakeClient();
    await postComment(c as any, "o", "r", 5, "hi");
    expect(c.rest.issues.createComment).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      issue_number: 5,
      body: "hi",
    });
  });

  it("getAuthenticatedLogin returns the token's login", async () => {
    const c = fakeClient();
    expect(await getAuthenticatedLogin(c as any)).toBe("Bob");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/github.test.ts`
Expected: FAIL — cannot find the helpers.

- [ ] **Step 3: Write the implementation**

```ts
import { App, Octokit } from "octokit";
import type { Config } from "./config";

// A minimal structural type so helpers are testable with a fake.
export interface GitHubClient {
  rest: {
    pulls: {
      get(args: { owner: string; repo: string; pull_number: number }): Promise<{
        data: { user: { login: string } | null; base: { ref: string } };
      }>;
      createReview(args: {
        owner: string;
        repo: string;
        pull_number: number;
        event: "APPROVE";
      }): Promise<unknown>;
    };
    issues: {
      createComment(args: {
        owner: string;
        repo: string;
        issue_number: number;
        body: string;
      }): Promise<unknown>;
    };
    users: {
      getAuthenticated(): Promise<{ data: { login: string } }>;
    };
  };
}

export function makeApp(cfg: Config): App {
  return new App({ appId: cfg.appId, privateKey: cfg.appPrivateKey });
}

export async function getInstallationClient(
  app: App,
  installationId: number,
): Promise<GitHubClient> {
  return (await app.getInstallationOctokit(installationId)) as unknown as GitHubClient;
}

export function clientForToken(pat: string): GitHubClient {
  return new Octokit({ auth: pat }) as unknown as GitHubClient;
}

export async function getPullRequest(
  client: GitHubClient,
  owner: string,
  repo: string,
  pull_number: number,
): Promise<{ author: string; baseRef: string }> {
  const { data } = await client.rest.pulls.get({ owner, repo, pull_number });
  return { author: data.user?.login ?? "", baseRef: data.base.ref };
}

export async function approve(
  client: GitHubClient,
  owner: string,
  repo: string,
  pull_number: number,
): Promise<void> {
  await client.rest.pulls.createReview({
    owner,
    repo,
    pull_number,
    event: "APPROVE",
  });
}

export async function postComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  issue_number: number,
  body: string,
): Promise<void> {
  await client.rest.issues.createComment({ owner, repo, issue_number, body });
}

export async function getAuthenticatedLogin(
  client: GitHubClient,
): Promise<string> {
  const { data } = await client.rest.users.getAuthenticated();
  return data.login;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/github.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/github.ts tests/github.test.ts
git commit -m "feat: Octokit helpers for PR read/approve/comment/whoami"
```

---

### Task 9: `api/register.ts` — `/setup` backend

**Files:**
- Create: `api/register.ts`
- Test: `tests/register.test.ts`

The handler is a Fetch-API function. Tests mock `lib/store` and `lib/github` and stub env.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/store", () => ({
  putPat: vi.fn(async () => {}),
  delPat: vi.fn(async () => {}),
}));
vi.mock("../lib/github", () => ({
  clientForToken: vi.fn(() => ({})),
  getAuthenticatedLogin: vi.fn(async () => "Bob"),
}));

import handler from "../api/register";
import { putPat, delPat } from "../lib/store";
import { getAuthenticatedLogin } from "../lib/github";

function env() {
  vi.stubEnv("APP_ID", "1");
  vi.stubEnv("APP_PRIVATE_KEY", "k");
  vi.stubEnv("WEBHOOK_SECRET", "w");
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("SETUP_ACCESS_CODE", "letmein");
}

function post(body: unknown): Request {
  return new Request("https://x/api/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("register handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    env();
  });

  it("rejects a wrong access code with 403", async () => {
    const res = await handler(post({ action: "register", accessCode: "nope", pat: "ghp_x" }));
    expect(res.status).toBe(403);
    expect(putPat).not.toHaveBeenCalled();
  });

  it("rejects an invalid PAT with 401", async () => {
    (getAuthenticatedLogin as any).mockRejectedValueOnce(new Error("bad"));
    const res = await handler(post({ action: "register", accessCode: "letmein", pat: "bad" }));
    expect(res.status).toBe(401);
    expect(putPat).not.toHaveBeenCalled();
  });

  it("registers a PAT under the verified login", async () => {
    const res = await handler(post({ action: "register", accessCode: "letmein", pat: "ghp_x" }));
    expect(res.status).toBe(200);
    expect(putPat).toHaveBeenCalledWith("Bob", "ghp_x", expect.any(Buffer));
    expect(await res.json()).toMatchObject({ login: "Bob" });
  });

  it("removes a PAT", async () => {
    const res = await handler(post({ action: "remove", accessCode: "letmein", pat: "ghp_x" }));
    expect(res.status).toBe(200);
    expect(delPat).toHaveBeenCalledWith("Bob");
  });

  it("405s on non-POST", async () => {
    const res = await handler(new Request("https://x/api/register", { method: "GET" }));
    expect(res.status).toBe(405);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/register.test.ts`
Expected: FAIL — cannot find `../api/register`.

- [ ] **Step 3: Write the implementation**

```ts
import { loadConfig } from "../lib/config";
import { putPat, delPat } from "../lib/store";
import { clientForToken, getAuthenticatedLogin } from "../lib/github";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const cfg = loadConfig();
  let payload: { action?: string; accessCode?: string; pat?: string };
  try {
    payload = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const { action = "register", accessCode, pat } = payload;
  if (accessCode !== cfg.setupAccessCode) {
    return json(403, { error: "Invalid access code" });
  }
  if (!pat) return json(400, { error: "Missing pat" });

  let login: string;
  try {
    login = await getAuthenticatedLogin(clientForToken(pat));
  } catch {
    return json(401, { error: "Token rejected by GitHub" });
  }

  if (action === "remove") {
    await delPat(login);
    return json(200, { login, removed: true });
  }

  await putPat(login, pat, cfg.encryptionKey);
  return json(200, { login, registered: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/register.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add api/register.ts tests/register.test.ts
git commit -m "feat: /setup registration endpoint (verify PAT -> DB)"
```

---

### Task 10: `api/webhook.ts` — orchestration

**Files:**
- Create: `api/webhook.ts`
- Test: `tests/webhook.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";

const installClient = { __tag: "install" };
vi.mock("../lib/github", () => ({
  makeApp: vi.fn(() => ({})),
  getInstallationClient: vi.fn(async () => installClient),
  clientForToken: vi.fn((pat: string) => ({ __pat: pat })),
  getPullRequest: vi.fn(async () => ({ author: "alice", baseRef: "feature/x" })),
  approve: vi.fn(async () => {}),
  postComment: vi.fn(async () => {}),
}));
vi.mock("../lib/store", () => ({
  listLogins: vi.fn(async () => ["bob", "carol"]),
  getPat: vi.fn(async (login: string) => `ghp_${login}`),
}));

import handler from "../api/webhook";
import { approve, postComment, getPullRequest } from "../lib/github";

const SECRET = "whsec";

function env() {
  vi.stubEnv("APP_ID", "1");
  vi.stubEnv("APP_PRIVATE_KEY", "k");
  vi.stubEnv("WEBHOOK_SECRET", SECRET);
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("SETUP_ACCESS_CODE", "code");
}

function event(body: string) {
  return {
    action: "created",
    issue: { number: 7, pull_request: {}, user: { login: "alice" } },
    comment: { body },
    repository: { owner: { login: "org" }, name: "repo" },
    installation: { id: 999 },
  };
}

function signedRequest(payload: unknown): Request {
  const raw = JSON.stringify(payload);
  const sig = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  return new Request("https://x/api/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sig,
      "x-github-event": "issue_comment",
    },
    body: raw,
  });
}

describe("webhook handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    env();
  });

  it("rejects a bad signature with 401", async () => {
    const raw = JSON.stringify(event("@pr-approver-bot @bob"));
    const res = await handler(
      new Request("https://x/api/webhook", {
        method: "POST",
        headers: { "x-hub-signature-256": "sha256=bad" },
        body: raw,
      }),
    );
    expect(res.status).toBe(401);
  });

  it("no-ops when the trigger is absent", async () => {
    const res = await handler(signedRequest(event("just chatting @bob")));
    expect(res.status).toBe(200);
    expect(approve).not.toHaveBeenCalled();
  });

  it("approves as each registered tagged user and comments", async () => {
    const res = await handler(signedRequest(event("@pr-approver-bot @bob @carol")));
    expect(res.status).toBe(200);
    expect(approve).toHaveBeenCalledTimes(2);
    expect(postComment).toHaveBeenCalledOnce();
    const summary = (postComment as any).mock.calls[0][4] as string;
    expect(summary).toContain("@bob");
    expect(summary).toContain("@carol");
  });

  it("skips unregistered users in the summary", async () => {
    const res = await handler(signedRequest(event("@pr-approver-bot @bob @dan")));
    expect(approve).toHaveBeenCalledTimes(1);
    const summary = (postComment as any).mock.calls[0][4] as string;
    expect(summary).toContain("@dan");
    expect(summary.toLowerCase()).toContain("no pat");
  });

  it("refuses protected base branch without approving", async () => {
    (getPullRequest as any).mockResolvedValueOnce({ author: "alice", baseRef: "main" });
    const res = await handler(signedRequest(event("@pr-approver-bot @bob")));
    expect(res.status).toBe(200);
    expect(approve).not.toHaveBeenCalled();
    const summary = (postComment as any).mock.calls[0][4] as string;
    expect(summary.toLowerCase()).toContain("main");
  });

  it("reports a per-user approval failure but still approves others", async () => {
    (approve as any)
      .mockRejectedValueOnce(new Error("401"))
      .mockResolvedValueOnce(undefined);
    const res = await handler(signedRequest(event("@pr-approver-bot @bob @carol")));
    expect(res.status).toBe(200);
    expect(approve).toHaveBeenCalledTimes(2);
    const summary = (postComment as any).mock.calls[0][4] as string;
    expect(summary).toMatch(/@bob|@carol/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webhook.test.ts`
Expected: FAIL — cannot find `../api/webhook`.

- [ ] **Step 3: Write the implementation**

```ts
import { loadConfig } from "../lib/config";
import { verifySignature } from "../lib/verify";
import { extractMentions, containsTrigger } from "../lib/parse";
import { decide } from "../lib/decide";
import { listLogins, getPat } from "../lib/store";
import {
  makeApp,
  getInstallationClient,
  clientForToken,
  getPullRequest,
  approve,
  postComment,
} from "../lib/github";

interface IssueCommentEvent {
  action: string;
  issue: { number: number; pull_request?: unknown; user: { login: string } };
  comment: { body: string };
  repository: { owner: { login: string }; name: string };
  installation?: { id: number };
}

export default async function handler(req: Request): Promise<Response> {
  const cfg = loadConfig();
  const raw = await req.text();

  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), cfg.webhookSecret)) {
    return new Response("invalid signature", { status: 401 });
  }

  const evt = JSON.parse(raw) as IssueCommentEvent;

  // Only top-level comments created on a PR.
  if (evt.action !== "created" || !evt.issue?.pull_request) {
    return new Response("ignored", { status: 200 });
  }
  if (!containsTrigger(evt.comment.body, cfg.triggerMention)) {
    return new Response("no trigger", { status: 200 });
  }
  if (!evt.installation) {
    return new Response("no installation", { status: 200 });
  }

  const owner = evt.repository.owner.login;
  const repo = evt.repository.name;
  const prNumber = evt.issue.number;

  const app = makeApp(cfg);
  const appClient = await getInstallationClient(app, evt.installation.id);
  const { author, baseRef } = await getPullRequest(appClient, owner, repo, prNumber);

  const registeredLogins = await listLogins();
  const result = decide({
    mentions: extractMentions(evt.comment.body),
    botMention: cfg.triggerMention,
    author,
    baseRef,
    protectedBranches: cfg.protectedBranches,
    registeredLogins,
  });

  if (result.blocked) {
    await postComment(
      appClient,
      owner,
      repo,
      prNumber,
      `🚫 I won't auto-approve PRs targeting \`${result.blockedBranch}\` (protected branch).`,
    );
    return new Response("blocked", { status: 200 });
  }

  const approved: string[] = [];
  const failed: string[] = [];
  for (const login of result.approveAs) {
    try {
      const pat = await getPat(login, cfg.encryptionKey);
      if (!pat) {
        failed.push(`@${login} — token missing`);
        continue;
      }
      await approve(clientForToken(pat), owner, repo, prNumber);
      approved.push(`@${login}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown error";
      failed.push(`@${login} — ${reason}`);
    }
  }

  const lines: string[] = [];
  if (approved.length) lines.push(`✅ Approved as ${approved.join(", ")}`);
  if (result.skippedNoPat.length) {
    lines.push(
      `⚠️ Skipped ${result.skippedNoPat
        .map((l) => `@${l}`)
        .join(", ")} — no PAT registered (visit /setup)`,
    );
  }
  if (failed.length) lines.push(`❌ ${failed.join("; ")}`);
  if (!lines.length) lines.push("Nobody to approve as — tag a registered reviewer.");

  await postComment(appClient, owner, repo, prNumber, lines.join("\n"));
  return new Response("ok", { status: 200 });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/webhook.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all test files pass; `tsc --noEmit` reports no errors.

- [ ] **Step 6: Commit**

```bash
git add api/webhook.ts tests/webhook.test.ts
git commit -m "feat: webhook handler orchestrating approvals + safeguard"
```

---

### Task 11: `public/setup.html` — registration form

**Files:**
- Create: `public/setup.html`

No automated test (static page); verified manually after deploy.

- [ ] **Step 1: Create the page**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PR Approver — Register your token</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; }
      label { display: block; margin: 1rem 0 0.25rem; font-weight: 600; }
      input { width: 100%; padding: 0.5rem; font-size: 1rem; box-sizing: border-box; }
      .row { display: flex; gap: 0.5rem; margin-top: 1.25rem; }
      button { flex: 1; padding: 0.6rem; font-size: 1rem; cursor: pointer; }
      #msg { margin-top: 1rem; padding: 0.75rem; border-radius: 0.25rem; display: none; }
      #msg.ok { background: #e6f4ea; color: #137333; display: block; }
      #msg.err { background: #fce8e6; color: #c5221f; display: block; }
      .hint { color: #666; font-size: 0.85rem; }
    </style>
  </head>
  <body>
    <h1>Register your GitHub PAT</h1>
    <p class="hint">
      Create a fine-grained PAT with <strong>Pull requests: Read and write</strong>
      on the target repos, then paste it below. We verify it against GitHub and
      store it under your verified username.
    </p>
    <label for="accessCode">Access code</label>
    <input id="accessCode" type="password" autocomplete="off" />
    <label for="pat">Personal Access Token</label>
    <input id="pat" type="password" autocomplete="off" placeholder="github_pat_… or ghp_…" />
    <div class="row">
      <button id="register">Register</button>
      <button id="remove">Remove</button>
    </div>
    <div id="msg"></div>

    <script>
      const msg = document.getElementById("msg");
      function show(ok, text) {
        msg.className = ok ? "ok" : "err";
        msg.textContent = text;
      }
      async function send(action) {
        const accessCode = document.getElementById("accessCode").value;
        const pat = document.getElementById("pat").value;
        try {
          const res = await fetch("/api/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, accessCode, pat }),
          });
          const data = await res.json();
          if (!res.ok) return show(false, data.error || "Request failed");
          show(true, action === "remove"
            ? `Removed @${data.login}`
            : `Registered as @${data.login}`);
        } catch (e) {
          show(false, "Network error");
        }
      }
      document.getElementById("register").onclick = () => send("register");
      document.getElementById("remove").onclick = () => send("remove");
    </script>
  </body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add public/setup.html
git commit -m "feat: /setup self-service PAT registration page"
```

---

### Task 12: `README.md` — setup documentation

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write the README**

````markdown
# PR Approver Bot

A GitHub App (hosted on Vercel) that approves a pull request on behalf of a
tagged reviewer, using that reviewer's own Personal Access Token.

Tag the bot together with a reviewer in a PR comment:

```
@pr-approver-bot @teammate please review
```

The bot submits an approving review **as `@teammate`** (using their registered
PAT) — for every registered, non-author user tagged in the comment.

> **Safeguard:** the bot never approves PRs whose base branch is protected
> (default `main`, `master`).

> **Trust note:** anyone who can comment can cause an approving review to be
> submitted as a colleague who registered a PAT. Use only within a trusting
> team, and rely on branch protection for `main`.

## Setup

### 1. Create the GitHub App

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.

- **Webhook URL:** `https://<your-vercel-app>.vercel.app/api/webhook`
- **Webhook secret:** pick a random string (you'll set it as `WEBHOOK_SECRET`).
- **Permissions:** Pull requests → **Read**; Issues → **Write**.
- **Subscribe to events:** Issue comments.
- Generate and download a **private key** (`.pem`).
- Note the **App ID**.

### 2. Install the App

Install it on the repositories (or the whole org) you want it to operate on.

### 3. Create the Vercel project + Neon database

- Import this repo into Vercel.
- Add a **Neon** database (Storage → Create → Neon) and connect it to the
  project. This injects `DATABASE_URL`.
- In Neon's SQL editor, create the table once:

  ```sql
  CREATE TABLE IF NOT EXISTS pats (
    login      text PRIMARY KEY,
    ciphertext text NOT NULL
  );
  ```

### 4. Configure environment variables

| Var | Value |
|---|---|
| `APP_ID` | the App ID |
| `APP_PRIVATE_KEY` | contents of the `.pem` (newlines may be `\n`-escaped) |
| `WEBHOOK_SECRET` | the webhook secret from step 1 |
| `ENCRYPTION_KEY` | 32-byte key: `openssl rand -hex 32` |
| `SETUP_ACCESS_CODE` | a shared code your team uses on `/setup` |
| `PROTECTED_BRANCHES` | *(optional)* comma list, default `main,master` |
| `TRIGGER_MENTION` | *(optional)* bot login, default `pr-approver-bot` |

(`DATABASE_URL` is injected automatically by the Neon integration.)

### 5. Deploy

Push to the connected branch (or click Deploy).

### 6. Register PATs

Each teammate:

1. Creates a fine-grained PAT scoped to the target repos with
   **Pull requests: Read and write**.
2. Visits `https://<your-vercel-app>.vercel.app/setup`.
3. Enters the access code + PAT and clicks **Register**.

To revoke: same page, **Remove** (or delete the PAT on GitHub).

### 7. Test

Open a PR into a non-protected branch and comment:

```
@pr-approver-bot @teammate
```

The bot replies with a summary of who it approved as.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: setup and usage README"
```

---

## Self-Review

**Spec coverage** — every Acceptance Criterion maps to a task:

- Signature verify + 401 → Task 3, Task 10.
- Trigger only on `issue_comment.created` on a PR → Task 10.
- Approve as each registered non-author tagged user → Task 5 (`decide`), Task 10.
- Never approve protected base branch + comment → Task 5, Task 10.
- Author excluded → Task 5.
- Unregistered users skipped + reported → Task 5, Task 10.
- Single summary comment (approved/skipped/failed) → Task 10.
- Per-user failure isolation → Task 10 (try/catch in loop).
- `/setup` registers under `GET /user` login, gated by access code → Task 9.
- PATs encrypted at rest → Task 2, Task 7.
- Self-service remove → Task 9, Task 11.
- Unit tests for parse/decide/config/crypto/signature → Tasks 2–6.
- README → Task 12.

**Placeholder scan:** none — every code step is complete.

**Type consistency:** `Config` fields, `DecideInput`/`DecideResult`, `GitHubClient`, and the `store`/`github` function signatures are used identically across Tasks 6–10. The webhook summary is built from `result.approveAs`/`result.skippedNoPat` plus runtime `approved`/`failed` arrays, matching the `decide` output shape.
