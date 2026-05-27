# Slack-Triggered PR Approver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the GitHub PR-comment trigger with a Slack slash command (`/approve-as <pr-url> @user…`) that approves a PR as each tagged, linked, registered reviewer using their own PAT.

**Architecture:** A new Fetch-API endpoint `api/slack.ts` verifies the Slack signature, parses the command, acks within 3s, and finishes the GitHub work via `waitUntil`, posting a summary to Slack's `response_url`. It reuses the existing pure `decide`, the Neon-backed `store` (extended with a Slack→GitHub link table), `crypto`, and Octokit helpers. The old GitHub-webhook path (`api/webhook.ts`, `lib/verify.ts`, `lib/parse.ts`, `postComment`) is deleted.

**Tech Stack:** TypeScript, Vercel Functions (Fetch handlers), `@vercel/functions` (`waitUntil`), `@neondatabase/serverless`, `octokit`, Node `crypto`, Vitest.

---

## File Structure (end state)

| File | Responsibility |
|---|---|
| `api/slack.ts` | Slack slash-command entry + `processApproval` core |
| `api/register.ts` | `/setup` backend (PAT + optional Slack link) |
| `public/setup.html` | Form: access code, PAT, optional Slack member ID |
| `lib/slack.ts` | Pure: `verifySlackSignature`, `parsePrUrl`, `parseSlackUserIds` |
| `lib/config.ts` | Env → `Config` (slackSigningSecret, botPat, encryptionKey, setupAccessCode, protectedBranches) |
| `lib/decide.ts` | Pure decision (unchanged) |
| `lib/store.ts` | Neon: `pats` + `slack_links` |
| `lib/crypto.ts` | AES-256-GCM (unchanged) |
| `lib/github.ts` | `clientForToken`, `getPullRequest`, `approve`, `getAuthenticatedLogin` |

**Deleted:** `api/webhook.ts`, `tests/webhook.test.ts`, `lib/verify.ts`, `tests/verify.test.ts`, `lib/parse.ts`, `tests/parse.test.ts`, and `postComment` from `lib/github.ts`.

Tasks are ordered so the full suite stays green after each.

---

### Task 1: Add the `@vercel/functions` dependency

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install**

Run: `npm install @vercel/functions`
Expected: adds `@vercel/functions` to dependencies; install succeeds.

- [ ] **Step 2: Verify it imports**

Run: `node -e "import('@vercel/functions').then(m=>console.log(typeof m.waitUntil))"`
Expected: prints `function`.

- [ ] **Step 3: Confirm tests still pass**

Run: `npm test`
Expected: all current tests pass (56).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @vercel/functions for waitUntil"
```

---

### Task 2: Delete the GitHub-comment trigger code

**Files:**
- Delete: `api/webhook.ts`, `tests/webhook.test.ts`, `lib/verify.ts`, `tests/verify.test.ts`, `lib/parse.ts`, `tests/parse.test.ts`
- Modify: `lib/github.ts` (remove `postComment`), `tests/github.test.ts` (remove the `postComment` test)

- [ ] **Step 1: Delete the dead files**

```bash
git rm api/webhook.ts tests/webhook.test.ts lib/verify.ts tests/verify.test.ts lib/parse.ts tests/parse.test.ts
```

- [ ] **Step 2: Remove `postComment` from `lib/github.ts`**

Open `lib/github.ts`. Remove the `postComment` function AND its `createComment` declaration inside the `GitHubClient` interface's `issues` block. If removing `createComment` leaves the `issues:` key empty, remove the whole `issues: { ... }` block. Keep `clientForToken`, `getPullRequest`, `approve`, `getAuthenticatedLogin`, and the `pulls`/`users` parts of `GitHubClient`. The resulting file must be exactly:

```ts
import { Octokit } from "octokit";

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
    users: {
      getAuthenticated(): Promise<{ data: { login: string } }>;
    };
  };
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

export async function getAuthenticatedLogin(
  client: GitHubClient,
): Promise<string> {
  const { data } = await client.rest.users.getAuthenticated();
  return data.login;
}
```

- [ ] **Step 3: Remove the `postComment` test from `tests/github.test.ts`**

In `tests/github.test.ts`, delete the entire `it("postComment posts to the issue", ...)` test block, and remove `issues: { createComment: vi.fn(...) }` from the `fakeClient()` return. Leave the other three tests (`getPullRequest`, `approve`, `getAuthenticatedLogin`) unchanged.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/github.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: full suite passes (webhook/verify/parse tests gone), `tsc --noEmit` clean. Nothing should still import `verifySignature`, `extractMentions`, `containsKeyword`, or `postComment`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove GitHub-comment trigger (Slack-only)"
```

---

### Task 3: Rework `lib/config.ts` for Slack

**Files:**
- Modify: `lib/config.ts`, `tests/config.test.ts`, `tests/register.test.ts`

- [ ] **Step 1: Update `tests/config.test.ts` (failing first)**

Replace the file with:

```ts
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
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL (Config still has old fields / triggerKeyword references).

- [ ] **Step 3: Update `lib/config.ts`**

Replace the `Config` interface and the `loadConfig` return. The full file becomes:

```ts
export interface Config {
  slackSigningSecret: string;
  botPat: string;
  encryptionKey: Buffer;
  setupAccessCode: string;
  protectedBranches: string[];
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
    slackSigningSecret: required(env, "SLACK_SIGNING_SECRET"),
    botPat: required(env, "BOT_PAT"),
    encryptionKey: parseKey(required(env, "ENCRYPTION_KEY")),
    setupAccessCode: required(env, "SETUP_ACCESS_CODE"),
    protectedBranches: protectedRaw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}
```

- [ ] **Step 4: Fix `tests/register.test.ts` env stub**

In `tests/register.test.ts`, the `env()` helper stubs the old vars. Replace its body so it stubs the new required set (it must satisfy `loadConfig`):

```ts
function env() {
  vi.stubEnv("SLACK_SIGNING_SECRET", "s");
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("SETUP_ACCESS_CODE", "letmein");
  vi.stubEnv("BOT_PAT", "ghp_bot");
}
```

Also, in the "returns a clean 500 when a required env var is missing" test in that file, it currently stubs `ENCRYPTION_KEY` to "" — leave that as-is (still a valid missing-required case).

- [ ] **Step 5: Run config + register tests**

Run: `npx vitest run tests/config.test.ts tests/register.test.ts`
Expected: both pass.

- [ ] **Step 6: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: green. (register.ts uses only `setupAccessCode`/`encryptionKey`; no references to removed fields remain.)

- [ ] **Step 7: Commit**

```bash
git add lib/config.ts tests/config.test.ts tests/register.test.ts
git commit -m "refactor: config for Slack (slackSigningSecret; drop webhook/keyword)"
```

---

### Task 4: `lib/slack.ts` — signature + parsing

**Files:**
- Create: `lib/slack.ts`
- Test: `tests/slack.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifySlackSignature,
  parsePrUrl,
  parseSlackUserIds,
} from "../lib/slack";

const secret = "shh";
const body = "command=/approve-as&text=hi";
const ts = Math.floor(Date.now() / 1000).toString();
const goodSig =
  "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");

describe("verifySlackSignature", () => {
  it("accepts a valid signature", () => {
    expect(verifySlackSignature(body, ts, goodSig, secret)).toBe(true);
  });
  it("rejects a wrong signature", () => {
    expect(verifySlackSignature(body, ts, "v0=deadbeef", secret)).toBe(false);
  });
  it("rejects a missing header", () => {
    expect(verifySlackSignature(body, ts, null, secret)).toBe(false);
    expect(verifySlackSignature(body, null, goodSig, secret)).toBe(false);
  });
  it("rejects a stale timestamp (replay)", () => {
    const oldTs = (Math.floor(Date.now() / 1000) - 60 * 10).toString();
    const sig =
      "v0=" +
      createHmac("sha256", secret).update(`v0:${oldTs}:${body}`).digest("hex");
    expect(verifySlackSignature(body, oldTs, sig, secret)).toBe(false);
  });
});

describe("parsePrUrl", () => {
  it("extracts owner/repo/number from a PR URL in the text", () => {
    expect(parsePrUrl("approve https://github.com/org/repo/pull/123 please")).toEqual(
      { owner: "org", repo: "repo", number: 123 },
    );
  });
  it("returns null when no PR URL is present", () => {
    expect(parsePrUrl("nothing here")).toBeNull();
  });
});

describe("parseSlackUserIds", () => {
  it("extracts unique Slack user IDs from escaped mentions", () => {
    expect(parseSlackUserIds("<@U1|alice> and <@U2> and <@U1>")).toEqual([
      "U1",
      "U2",
    ]);
  });
  it("returns [] when there are no mentions", () => {
    expect(parseSlackUserIds("just text")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run tests/slack.test.ts`
Expected: FAIL — cannot find `../lib/slack`.

- [ ] **Step 3: Implement `lib/slack.ts`**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  // Replay protection: reject requests older than 5 minutes.
  if (Math.abs(nowMs / 1000 - ts) > 300) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected =
    "v0=" + createHmac("sha256", secret).update(base).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parsePrUrl(
  text: string,
): { owner: string; repo: string; number: number } | null {
  const m = text.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

export function parseSlackUserIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run tests/slack.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/slack.ts tests/slack.test.ts
git commit -m "feat: Slack signature verification + command parsing"
```

---

### Task 5: `lib/store.ts` — Slack→login link table

**Files:**
- Modify: `lib/store.ts`, `tests/store.test.ts`

- [ ] **Step 1: Extend `tests/store.test.ts` (failing first)**

In `tests/store.test.ts`, the mocked `query` uses an in-memory `mem` Map for `pats`. Add a SECOND map for `slack_links` and branches for it. Change the top of the file's mock so the `query` function also handles the link table:

Add near the top (after `const mem = new Map<string, string>();`):
```ts
const links = new Map<string, string>(); // slack_user_id -> login
```

Inside the `query` mock, add these branches (before the final `throw`):
```ts
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
```

Update the import line to add the new functions:
```ts
import {
  putPat,
  getPat,
  delPat,
  listLogins,
  putSlackLink,
  getLoginForSlack,
  delSlackLink,
} from "../lib/store";
```

In the `beforeEach`, also clear links:
```ts
  beforeEach(() => {
    mem.clear();
    links.clear();
  });
```

Add these tests inside the `describe("store", ...)` block:
```ts
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
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `putSlackLink` etc. not exported.

- [ ] **Step 3: Add the functions to `lib/store.ts`**

Append to `lib/store.ts` (the file already has `db()` and `norm()`):

```ts
export async function putSlackLink(
  slackUserId: string,
  login: string,
): Promise<void> {
  await db()(
    `INSERT INTO slack_links (slack_user_id, login) VALUES ($1, $2)
     ON CONFLICT (slack_user_id) DO UPDATE SET login = EXCLUDED.login`,
    [slackUserId, norm(login)],
  );
}

export async function getLoginForSlack(
  slackUserId: string,
): Promise<string | null> {
  const rows = (await db()(`SELECT login FROM slack_links WHERE slack_user_id = $1`, [
    slackUserId,
  ])) as { login: string }[];
  return rows[0]?.login ?? null;
}

export async function delSlackLink(slackUserId: string): Promise<void> {
  await db()(`DELETE FROM slack_links WHERE slack_user_id = $1`, [slackUserId]);
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/store.ts tests/store.test.ts
git commit -m "feat: Slack→GitHub login link store"
```

---

### Task 6: `/setup` Slack-ID linking in `api/register.ts`

**Files:**
- Modify: `api/register.ts`, `tests/register.test.ts`, `public/setup.html`

- [ ] **Step 1: Extend `tests/register.test.ts` (failing first)**

Update the `vi.mock("../lib/store", ...)` block to add the link functions:
```ts
vi.mock("../lib/store", () => ({
  putPat: vi.fn(async () => {}),
  delPat: vi.fn(async () => {}),
  putSlackLink: vi.fn(async () => {}),
  delSlackLink: vi.fn(async () => {}),
}));
```

Add `putSlackLink, delSlackLink` to the store import:
```ts
import { putPat, delPat, putSlackLink, delSlackLink } from "../lib/store";
```

Add these tests inside the describe block:
```ts
  it("stores a Slack link when slackUserId is provided on register", async () => {
    const res = await handler(
      post({ action: "register", accessCode: "letmein", pat: "ghp_x", slackUserId: "U9" }),
    );
    expect(res.status).toBe(200);
    expect(putSlackLink).toHaveBeenCalledWith("U9", "Bob");
  });

  it("does not store a Slack link when slackUserId is omitted", async () => {
    await handler(post({ action: "register", accessCode: "letmein", pat: "ghp_x" }));
    expect(putSlackLink).not.toHaveBeenCalled();
  });

  it("removes the Slack link on remove when slackUserId is provided", async () => {
    const res = await handler(
      post({ action: "remove", accessCode: "letmein", pat: "ghp_x", slackUserId: "U9" }),
    );
    expect(res.status).toBe(200);
    expect(delSlackLink).toHaveBeenCalledWith("U9");
  });
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run tests/register.test.ts`
Expected: FAIL — `putSlackLink` not called (handler doesn't do it yet).

- [ ] **Step 3: Update `api/register.ts`**

Add `putSlackLink, delSlackLink` to the store import:
```ts
import { putPat, delPat, putSlackLink, delSlackLink } from "../lib/store";
```

Change the payload type and destructure to include `slackUserId`:
```ts
  let payload: {
    action?: string;
    accessCode?: string;
    pat?: string;
    slackUserId?: string;
  };
```
```ts
  const { action = "register", accessCode, pat, slackUserId } = payload;
```

Replace the final store-write try/catch block with:
```ts
  try {
    if (action === "remove") {
      await delPat(login);
      if (slackUserId) await delSlackLink(slackUserId);
      return json(200, { login, removed: true });
    }
    await putPat(login, pat, cfg.encryptionKey);
    if (slackUserId) await putSlackLink(slackUserId, login);
    return json(200, { login, registered: true });
  } catch (err) {
    console.error("register store failure:", err);
    return json(500, { error: "Storage error" });
  }
```

- [ ] **Step 4: Run register tests**

Run: `npx vitest run tests/register.test.ts`
Expected: PASS (all, including the 3 new).

- [ ] **Step 5: Add the Slack member ID field to `public/setup.html`**

In `public/setup.html`, add an input after the PAT input (before the `.row` of buttons):
```html
    <label for="slackUserId">Slack member ID <span class="hint">(optional, for Slack approvals)</span></label>
    <input id="slackUserId" type="text" autocomplete="off" placeholder="e.g. U01ABCDEFG" />
```

In the `<script>`, update `send` to read and include it:
```js
      async function send(action) {
        const accessCode = document.getElementById("accessCode").value;
        const pat = document.getElementById("pat").value;
        const slackUserId = document.getElementById("slackUserId").value.trim();
        try {
          const res = await fetch("/api/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, accessCode, pat, slackUserId: slackUserId || undefined }),
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
```

- [ ] **Step 6: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add api/register.ts tests/register.test.ts public/setup.html
git commit -m "feat: link Slack member ID to GitHub login at /setup"
```

---

### Task 7: `api/slack.ts` — slash-command handler + approval core

**Files:**
- Create: `api/slack.ts`
- Test: `tests/slack-api.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("@vercel/functions", () => ({
  // run the work synchronously so tests can await its effects
  waitUntil: (p: Promise<unknown>) => p,
}));
vi.mock("../lib/github", () => ({
  clientForToken: vi.fn((pat: string) => ({ __pat: pat })),
  getPullRequest: vi.fn(async () => ({ author: "alice", baseRef: "feature/x" })),
  approve: vi.fn(async () => {}),
}));
vi.mock("../lib/store", () => ({
  listLogins: vi.fn(async () => ["bob", "carol"]),
  getPat: vi.fn(async (login: string) => `ghp_${login}`),
  getLoginForSlack: vi.fn(async (id: string) =>
    ({ U_BOB: "bob", U_CAROL: "carol" } as Record<string, string>)[id] ?? null,
  ),
}));

import handler, { processApproval } from "../api/slack";
import { approve, getPullRequest } from "../lib/github";
import type { Config } from "../lib/config";

const SECRET = "slacksecret";

function env() {
  vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("SETUP_ACCESS_CODE", "code");
  vi.stubEnv("BOT_PAT", "ghp_bot");
}

const cfg: Config = {
  slackSigningSecret: SECRET,
  botPat: "ghp_bot",
  encryptionKey: Buffer.alloc(32, 1),
  setupAccessCode: "code",
  protectedBranches: ["main", "master"],
};

const PR = "https://github.com/org/repo/pull/7";

function slackRequest(text: string): Request {
  const body = new URLSearchParams({
    command: "/approve-as",
    text,
    response_url: "https://hooks.slack.test/r/abc",
  }).toString();
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig =
    "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex");
  return new Request("https://x/api/slack", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-signature": sig,
      "x-slack-request-timestamp": ts,
    },
    body,
  });
}

describe("processApproval", () => {
  beforeEach(() => vi.clearAllMocks());

  it("approves resolved + registered reviewers", async () => {
    const summary = await processApproval({
      pr: { owner: "org", repo: "repo", number: 7 },
      slackUserIds: ["U_BOB", "U_CAROL"],
      cfg,
    });
    expect(approve).toHaveBeenCalledTimes(2);
    expect(summary).toContain("@bob");
    expect(summary).toContain("@carol");
  });

  it("reports unlinked Slack users", async () => {
    const summary = await processApproval({
      pr: { owner: "org", repo: "repo", number: 7 },
      slackUserIds: ["U_BOB", "U_STRANGER"],
      cfg,
    });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(summary).toContain("<@U_STRANGER>");
    expect(summary.toLowerCase()).toContain("not linked");
  });

  it("refuses a protected base branch without approving", async () => {
    (getPullRequest as any).mockResolvedValueOnce({ author: "alice", baseRef: "main" });
    const summary = await processApproval({
      pr: { owner: "org", repo: "repo", number: 7 },
      slackUserIds: ["U_BOB"],
      cfg,
    });
    expect(approve).not.toHaveBeenCalled();
    expect(summary.toLowerCase()).toContain("main");
  });

  it("returns a usage message when no PR URL", async () => {
    const summary = await processApproval({ pr: null, slackUserIds: ["U_BOB"], cfg });
    expect(approve).not.toHaveBeenCalled();
    expect(summary.toLowerCase()).toContain("pr url");
  });
});

describe("slack handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    env();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
  });

  it("rejects a bad signature with 401", async () => {
    const body = "text=hi";
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(
      new Request("https://x/api/slack", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-signature": "v0=bad",
          "x-slack-request-timestamp": ts,
        },
        body,
      }),
    );
    expect(res.status).toBe(401);
    expect(approve).not.toHaveBeenCalled();
  });

  it("acks 200, approves, and posts the summary to response_url", async () => {
    const res = await handler(slackRequest(`${PR} <@U_BOB> <@U_CAROL>`));
    expect(res.status).toBe(200);
    expect(approve).toHaveBeenCalledTimes(2);
    const fetchMock = globalThis.fetch as any;
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.slack.test/r/abc",
      expect.objectContaining({ method: "POST" }),
    );
    const posted = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(posted.text).toContain("@bob");
  });

  it("returns a clean 500 when SLACK_SIGNING_SECRET is missing", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "");
    const res = await handler(slackRequest(`${PR} <@U_BOB>`));
    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run tests/slack-api.test.ts`
Expected: FAIL — cannot find `../api/slack`.

- [ ] **Step 3: Implement `api/slack.ts`**

```ts
import { waitUntil } from "@vercel/functions";
import { loadConfig, type Config } from "../lib/config";
import { verifySlackSignature, parsePrUrl, parseSlackUserIds } from "../lib/slack";
import { decide } from "../lib/decide";
import { listLogins, getPat, getLoginForSlack } from "../lib/store";
import { clientForToken, getPullRequest, approve } from "../lib/github";

interface ProcessInput {
  pr: { owner: string; repo: string; number: number } | null;
  slackUserIds: string[];
  cfg: Config;
}

export async function processApproval(input: ProcessInput): Promise<string> {
  const { pr, slackUserIds, cfg } = input;
  if (!pr) {
    return "⚠️ Couldn't find a GitHub PR URL in your command. Usage: `/approve-as <pr-url> @user`";
  }

  const resolved: string[] = [];
  const notLinked: string[] = [];
  for (const id of slackUserIds) {
    const login = await getLoginForSlack(id);
    if (login) resolved.push(login);
    else notLinked.push(id);
  }

  const botClient = clientForToken(cfg.botPat);
  const { author, baseRef } = await getPullRequest(
    botClient,
    pr.owner,
    pr.repo,
    pr.number,
  );

  const registeredLogins = await listLogins();
  const result = decide({
    mentions: resolved,
    author,
    baseRef,
    protectedBranches: cfg.protectedBranches,
    registeredLogins,
  });

  if (result.blocked) {
    return `🚫 I won't auto-approve PRs targeting \`${result.blockedBranch}\` (protected branch).`;
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
      await approve(clientForToken(pat), pr.owner, pr.repo, pr.number);
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
  if (notLinked.length) {
    lines.push(
      `⚠️ Not linked: ${notLinked
        .map((id) => `<@${id}>`)
        .join(", ")} — link your Slack ID at /setup`,
    );
  }
  if (failed.length) lines.push(`❌ ${failed.join("; ")}`);
  if (!lines.length) {
    lines.push("Nobody to approve as — tag a registered, linked reviewer.");
  }
  return lines.join("\n");
}

async function postToSlack(responseUrl: string, text: string): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response_type: "in_channel", text }),
  });
}

export default async function handler(req: Request): Promise<Response> {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error("slack config error:", err);
    return new Response("configuration error", { status: 500 });
  }

  const raw = await req.text();
  const ok = verifySlackSignature(
    raw,
    req.headers.get("x-slack-request-timestamp"),
    req.headers.get("x-slack-signature"),
    cfg.slackSigningSecret,
  );
  if (!ok) return new Response("invalid signature", { status: 401 });

  const form = new URLSearchParams(raw);
  const text = form.get("text") ?? "";
  const responseUrl = form.get("response_url");

  const pr = parsePrUrl(text);
  const slackUserIds = parseSlackUserIds(text);

  // Finish the GitHub work after acking; post the result to Slack.
  waitUntil(
    (async () => {
      try {
        const summary = await processApproval({ pr, slackUserIds, cfg });
        if (responseUrl) await postToSlack(responseUrl, summary);
      } catch (err) {
        console.error("slack approval failed:", err);
        if (responseUrl) {
          await postToSlack(responseUrl, "❌ Something went wrong processing the approval.");
        }
      }
    })(),
  );

  // Ack within Slack's 3s window.
  return new Response(
    JSON.stringify({ response_type: "ephemeral", text: "⏳ Working on it…" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run tests/slack-api.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all green, `tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add api/slack.ts tests/slack-api.test.ts
git commit -m "feat: Slack slash-command handler + approval core"
```

---

### Task 8: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite `README.md`**

Replace the whole file with:

````markdown
# PR Approver Bot (Slack)

A Slack slash command that approves a GitHub pull request on behalf of tagged
reviewers, using each reviewer's own Personal Access Token.

In Slack:

```
/approve-as https://github.com/org/repo/pull/123 @bob @carol
```

The bot resolves each tagged Slack user to their linked GitHub login and submits
an approving review **as each of them**, then replies in-channel with a summary.

> **Safeguard:** the bot never approves PRs whose base branch is protected
> (default `main`, `master`).

> **Trust note:** anyone who can run the command can cause an approving review
> to be submitted as a colleague who registered a PAT. Use only within a
> trusting team, and rely on branch protection for `main`.

## Setup

### 1. Vercel project + Neon database

- Import this repo into Vercel.
- Add a **Neon** database (Storage → Create → Neon); it injects `DATABASE_URL`.
- In Neon's SQL editor, create both tables:

  ```sql
  CREATE TABLE IF NOT EXISTS pats (
    login      text PRIMARY KEY,
    ciphertext text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS slack_links (
    slack_user_id text PRIMARY KEY,
    login         text NOT NULL
  );
  ```
- Deploy once to get your domain (`https://<app>.vercel.app`).

### 2. Create a BOT_PAT

A GitHub PAT (your own or a machine account) with **Pull requests: Read** on the
target repos — it only reads PRs (base branch + author).

### 3. Create the Slack app

- api.slack.com/apps → Create New App → From scratch → pick your workspace.
- **Slash Commands → Create New Command:**
  - Command: `/approve-as`
  - Request URL: `https://<app>.vercel.app/api/slack`
  - Enable **"Escape channels, users, and links sent to your app"**.
- **Basic Information → App Credentials → Signing Secret** → this is `SLACK_SIGNING_SECRET`.
- Install the app to your workspace.

### 4. Configure Vercel env vars (then redeploy)

| Var | Value |
|---|---|
| `SLACK_SIGNING_SECRET` | from the Slack app's Basic Information |
| `BOT_PAT` | the PAT from step 2 |
| `ENCRYPTION_KEY` | 32-byte key: `openssl rand -hex 32` |
| `SETUP_ACCESS_CODE` | a shared code your team uses on `/setup` |
| `PROTECTED_BRANCHES` | *(optional)* comma list, default `main,master` |

(`DATABASE_URL` is injected by Neon.)

### 5. Register + link (each teammate)

1. Create a fine-grained PAT with **Pull requests: Read and write** on the repos.
2. Find your Slack member ID: Slack profile → ⋮ (More) → **Copy member ID**.
3. Visit `https://<app>.vercel.app/setup`, enter the access code, your PAT, and
   your Slack member ID, click **Register**.

To revoke: same page, **Remove** (or delete the PAT on GitHub).

### 6. Test

In Slack: `/approve-as https://github.com/org/repo/pull/<n> @teammate` into a
non-protected branch. The bot replies with a summary and the approval appears.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```
````

- [ ] **Step 2: Confirm tests unaffected**

Run: `npm test`
Expected: full suite green.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README for Slack slash-command flow"
```

---

## Self-Review

**Spec coverage** — each Acceptance Criterion maps to a task:
- Slack signature verify + 401 (incl. stale) → Task 4 (`verifySlackSignature`), Task 7 (handler).
- Ack <3s + `waitUntil` + post to response_url → Task 7.
- PR identified by URL → Task 4 (`parsePrUrl`), Task 7.
- Slack users resolved via `slack_links`; unmapped reported → Task 5, Task 7 (`processApproval`).
- Approve resolved/registered/non-author reviewers → Task 7 (uses `decide`).
- Protected-branch safeguard + message → Task 7.
- Unregistered logins skipped/reported → Task 7.
- Per-user failure isolation → Task 7 (try/catch in loop).
- `/setup` stores `slackUserId → login` → Task 6.
- PATs encrypted in Neon → existing `crypto` + `store` (unchanged).
- GitHub comment trigger + code removed → Task 2.
- Unit tests for slack/processApproval/store-links/config/register → Tasks 3–7.

**Placeholder scan:** none — every code step is complete.

**Type consistency:** `Config` (Task 3) is used identically in Task 7 (`processApproval` and handler) and the test's `cfg` literal. `ProcessInput` (`pr`/`slackUserIds`/`cfg`) matches between `api/slack.ts` and `tests/slack-api.test.ts`. `decide` is called with `{mentions, author, baseRef, protectedBranches, registeredLogins}` — matching the existing `DecideInput` (which already dropped `botMention`). Store functions `putSlackLink(slackUserId, login)` / `getLoginForSlack(slackUserId)` / `delSlackLink(slackUserId)` are used identically in Tasks 5–7.
