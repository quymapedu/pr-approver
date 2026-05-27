# PR Approver Bot — Design

**Date:** 2026-05-27
**Status:** Approved (design)

## Purpose

A GitHub App that approves pull requests on behalf of a tagged reviewer, using
that reviewer's own Personal Access Token (PAT). The intended workflow:

1. Author **A** opens a PR.
2. **A** requests review by commenting and tagging both the bot and reviewer
   **B**: `@pr-approver-bot @B please review`.
3. The bot detects its mention, finds **B**'s registered PAT, and submits an
   approving review **as B**.

The bot exists to remove friction in a small, mutually-trusting team. It is not
a security control and deliberately bypasses the human step of review — every
participant registers their own PAT knowingly. The one hard safeguard is that
the bot **never** approves PRs targeting protected branches (default
`main`, `master`).

## Scope

In scope:
- A single webhook endpoint that reacts to PR comments and approves as the
  tagged user(s).
- A self-service `/setup` page where teammates register/remove their own PAT.
- Encrypted-at-rest PAT storage in Neon (serverless Postgres).
- The protected-branch safeguard.

Out of scope (YAGNI):
- Any web UI beyond the single `/setup` form.
- Roles/permissions, audit dashboards, analytics.
- Approving via the PR description body, review threads, or reactions — only
  top-level issue comments on a PR trigger the bot.
- Requesting changes / dismissing reviews — approve only.

## Hosting & stack

- **Vercel free tier**, Node serverless functions (Fetch-API handlers). No
  long-running server.
- **TypeScript.**
- **Neon** (serverless Postgres, free tier) for PAT storage, via the
  `@neondatabase/serverless` HTTP driver — no TCP connection pooling concerns in
  short-lived serverless functions.
- Octokit libraries:
  - `@octokit/webhooks` — verify `X-Hub-Signature-256`, parse typed events.
  - `@octokit/app` — mint an installation token (read PR, post status comment).
  - `@octokit/rest` — one instance per tagged user, authed with their PAT, used
    **only** to submit the approving review.
- Tests: **Vitest**.

## GitHub App configuration

- **Permissions:** Pull requests → **Read** (fetch the PR and its base branch);
  Issues → **Write** (post the summary comment — PR-conversation comments are
  issue comments). Approvals never use the App token; they use the tagged
  user's PAT.
- **Webhook events:** Issue comments.
- **Webhook URL:** the deployed Vercel function (`/api/webhook`).
- **Webhook secret:** matches `WEBHOOK_SECRET`.
- A private key is generated and stored as `APP_PRIVATE_KEY`.
- Installed on the target repos/org.

## Architecture

Three serverless entry points plus pure-logic libraries:

| File | Responsibility |
|---|---|
| `api/webhook.ts` | HTTP entry for GitHub webhooks: verify signature, route, orchestrate the approve flow. |
| `api/register.ts` | HTTP entry for `/setup`: verify access code, verify PAT via `GET /user`, upsert/remove in the DB. |
| `public/setup.html` | Static paste-PAT form posting to `/api/register`. |
| `lib/config.ts` | Load + validate env vars; fail fast with clear errors. |
| `lib/parse.ts` | Extract the trigger mention and all `@mentioned` logins from a comment body. |
| `lib/decide.ts` | **Pure** decision logic (no I/O). |
| `lib/store.ts` | Postgres read/write of `login → encrypted PAT`, plus list/remove. |
| `lib/crypto.ts` | AES-256-GCM encrypt/decrypt using `ENCRYPTION_KEY`. |
| `lib/github.ts` | Octokit helpers: installation token, `getPullRequest`, `approveAs(pat)`, `postComment`. |

`parse` and `decide` contain the logic that's easiest to get wrong and are
fully unit-testable without network or a database.

## Webhook flow (`/api/webhook`)

```
issue_comment.created received
  1. Verify X-Hub-Signature-256          → invalid: 401
  2. action == "created" and on a PR?    → no: 200 no-op
  3. body contains TRIGGER_MENTION?      → no: 200 no-op
  4. parse() → all @mentions in body
  5. candidates = mentions
        minus the bot's own mention
        minus the PR author (GitHub forbids self-approval)
  6. fetch PR via App installation token → base.ref
  7. SAFEGUARD: base.ref in PROTECTED_BRANCHES?
        → yes: post "🚫 won't auto-approve PRs into `<branch>`", 200 stop
  8. for each candidate:
        registered in DB?  → no: add to "skipped (no PAT)"
        yes: decrypt PAT, approveAs(pat)
              success → "approved"
              failure → "failed (reason)"   (caught, not fatal)
  9. post ONE summary comment via App token, e.g.:
        ✅ Approved as @bob, @carol
        ⚠️ Skipped @dan — no PAT registered (visit /setup)
        ❌ @eve — token rejected (401)
  10. return 200
```

Notes:
- The function does its work then returns 2xx, so GitHub does not retry.
- An empty candidate set after step 5 → post a short "nobody to approve as"
  note and stop.

## Decision logic (`lib/decide.ts`, pure)

```
decide({
  mentions: string[],        // all @logins from the comment
  botMention: string,        // the trigger login, e.g. "pr-approver-bot"
  author: string,            // PR author login
  baseRef: string,           // PR base branch
  protectedBranches: string[],
  registeredLogins: string[] // who has a PAT in the DB
}) => {
  blocked: boolean,          // base branch protected
  blockedBranch?: string,
  approveAs: string[],       // registered, non-author, non-bot
  skippedNoPat: string[],    // mentioned + eligible but no PAT
}
```

Login comparison is case-insensitive (GitHub logins are case-insensitive). The
bot mention and author are always excluded before bucketing into
`approveAs` / `skippedNoPat`.

## Registration flow (`/api/register`, `/setup`)

`POST /api/register` body: `{ action: "register" | "remove", accessCode, pat }`

```
1. accessCode == SETUP_ACCESS_CODE?     → no: 403
2. call GET /user with the supplied PAT → invalid: 401 "token rejected"
3. login = response.login
4. register: store.put(login, encrypt(pat))   → 200 "Registered as @login"
   remove:   store.del(login)                 → 200 "Removed @login"
```

The PAT itself is the proof of identity — a user can only register/remove a
token they actually possess, and the stored key is guaranteed to be the real
login. No username field is collected from the form.

`public/setup.html` is a minimal form: access code, PAT, Register / Remove
buttons; shows the server's success/error message.

## Storage & encryption

- Single table `pats(login text primary key, ciphertext text not null)`. The
  `ciphertext` is the AES-256-GCM blob (iv + authTag + data, base64). The
  encryption key never lives in the database.
- `login` is the primary key, so register is an idempotent upsert
  (`INSERT … ON CONFLICT (login) DO UPDATE`).
- `lib/crypto.ts` uses Node `crypto` with a 32-byte key from `ENCRYPTION_KEY`
  (base64 or hex). Random 12-byte IV per write.
- `store.listLogins()` returns registered logins (for the webhook's lookups /
  "skipped" messaging) without ever returning plaintext tokens.

## Configuration (env vars)

| Var | Required | Purpose |
|---|---|---|
| `APP_ID` | yes | GitHub App ID |
| `APP_PRIVATE_KEY` | yes | GitHub App private key (PEM) |
| `WEBHOOK_SECRET` | yes | Verifies webhook signatures |
| `ENCRYPTION_KEY` | yes | 32-byte key (base64/hex) for PAT encryption |
| `SETUP_ACCESS_CODE` | yes | Shared code gating `/api/register` |
| `DATABASE_URL` | yes | Neon connection string, injected by the Neon integration |
| `PROTECTED_BRANCHES` | no (default `main,master`) | Comma-separated branches the bot refuses |
| `TRIGGER_MENTION` | no (default app bot login) | The `@name` that triggers the bot |

`lib/config.ts` validates presence and shape at startup of each invocation and
throws a clear error if misconfigured.

## Error handling

- Bad/missing webhook signature → **401**.
- No trigger / not a PR / wrong action → **200** no-op (silent).
- PR fetch failure → log, return **500** (GitHub may retry; acceptable).
- Per-user approve failure (expired/invalid PAT, self-approval 422, etc.) →
  caught per user, reported in the summary comment, never aborts the others.
- `/api/register`: wrong access code → 403; invalid PAT → 401; DB failure → 500.

## Testing

Vitest unit tests:
- `parse`: extracts trigger + mentions from varied comment bodies (multiple
  mentions, no mentions, mention inside code span ignored, trailing
  punctuation).
- `decide`: protected-branch block; author excluded; bot excluded;
  registered → `approveAs`; mentioned-but-unregistered → `skippedNoPat`;
  case-insensitive matching; empty result.
- `config`: missing required var throws; defaults applied.
- `crypto`: encrypt→decrypt round-trips; tampered ciphertext rejected.
- Signature verification: valid signature passes, invalid rejected (using
  `@octokit/webhooks` verify).

`github.ts` network calls are exercised via mocked Octokit in handler-level
tests (the `store` test mocks `@neondatabase/serverless` with an in-memory
`query()`); the live GitHub/Neon integration is validated manually in setup.

## Setup steps (also goes in README)

1. **Create the GitHub App** (Settings → Developer settings → GitHub Apps):
   set webhook URL to the Vercel deployment `/api/webhook`, set a webhook
   secret, grant permissions (Pull requests: **Read**, Issues: **Write** —
   the App only reads PRs and posts the summary comment; approvals use PATs),
   subscribe to **Issue comments**, generate a private key.
2. **Install the App** on the target repos/org.
3. **Create the Vercel project**, link this repo, add a **Neon** database from
   the Marketplace (Storage → Create → Neon). This injects `DATABASE_URL`.
4. **Create the schema** in Neon's SQL editor:
   `CREATE TABLE IF NOT EXISTS pats (login text PRIMARY KEY, ciphertext text NOT NULL);`
5. **Set env vars** in Vercel: `APP_ID`, `APP_PRIVATE_KEY`, `WEBHOOK_SECRET`,
   `ENCRYPTION_KEY`, `SETUP_ACCESS_CODE`, `PROTECTED_BRANCHES` (optional),
   `TRIGGER_MENTION` (optional). `DATABASE_URL` is injected by the integration.
6. **Deploy.**
7. **Each teammate registers a PAT:** create a fine-grained PAT scoped to the
   repos with **Pull requests: Read and write**, then visit `/setup`, enter the
   access code + PAT, click Register.
8. **Test:** open a PR into a non-protected branch and comment
   `@pr-approver-bot @teammate`.

## Acceptance Criteria

- [ ] Webhook verifies the GitHub signature and rejects invalid ones with 401.
- [ ] Bot triggers only on `issue_comment.created` on a PR containing the
      trigger mention.
- [ ] Bot approves as every other registered, non-author user tagged in the
      comment, using their PAT.
- [ ] Bot never approves PRs whose base branch is in `PROTECTED_BRANCHES`
      (default `main`, `master`) and says so in a comment.
- [ ] PR author is excluded from approval candidates.
- [ ] Tagged users without a registered PAT are skipped and reported.
- [ ] One summary comment reports approved / skipped / failed per user.
- [ ] A per-user approval failure does not prevent the others from succeeding.
- [ ] `/setup` registers a PAT under the login returned by `GET /user`, gated
      by the access code.
- [ ] PATs are stored encrypted (AES-256-GCM) in Neon Postgres.
- [ ] A user can remove their own PAT via `/setup`.
- [ ] Unit tests cover `parse`, `decide`, `config`, `crypto`, and signature
      verification.
- [ ] README documents the full setup flow.
