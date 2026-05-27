# PR Approver Bot — Design

**Date:** 2026-05-27
**Status:** Approved (design)

> **Update 2026-05-27:** Pivoted from a GitHub App to a plain repo/org webhook
> with a keyword trigger (`/approve-as`) and a `BOT_PAT` for PR reads + summary
> comments — installing a GitHub App on the org was blocked. The
> approve/decide/store/encryption/`/setup` design is unchanged.

## Purpose

A webhook-based bot that approves pull requests on behalf of tagged reviewers,
using each reviewer's own Personal Access Token (PAT). The intended workflow:

1. Author **A** opens a PR.
2. **A** triggers the bot by commenting with the keyword and tagging reviewer
   **B**: `/approve-as @B`.
3. The bot detects the keyword, finds **B**'s registered PAT, and submits an
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
  - `@octokit/rest` — one instance per user (reviewer PAT) plus one instance
    for `BOT_PAT` (read PR, post summary comment).
- Tests: **Vitest**.

## Webhook configuration

Add a webhook in each target repo (or at the org level) pointing at the
deployed Vercel function:

- **Payload URL:** `https://<domain>/api/webhook`
- **Content type:** `application/json`
- **Secret:** matches `WEBHOOK_SECRET`
- **Events:** Issue comments only (no GitHub App installation required)

A `BOT_PAT` (GitHub PAT, user's own or a machine account) is used by the
server to read the PR's base branch and post the summary comment. Approvals
never use `BOT_PAT`; they use each reviewer's registered PAT.

## Architecture

Three serverless entry points plus pure-logic libraries:

| File | Responsibility |
|---|---|
| `api/webhook.ts` | HTTP entry for GitHub webhooks: verify signature, route, orchestrate the approve flow. |
| `api/register.ts` | HTTP entry for `/setup`: verify access code, verify PAT via `GET /user`, upsert/remove in the DB. |
| `public/setup.html` | Static paste-PAT form posting to `/api/register`. |
| `lib/config.ts` | Load + validate env vars; fail fast with clear errors. |
| `lib/parse.ts` | `containsKeyword` checks for the trigger keyword; `extractMentions` pulls all `@mentioned` logins from a comment body. |
| `lib/decide.ts` | **Pure** decision logic (no I/O). |
| `lib/store.ts` | Postgres read/write of `login → encrypted PAT`, plus list/remove. |
| `lib/crypto.ts` | AES-256-GCM encrypt/decrypt using `ENCRYPTION_KEY`. |
| `lib/github.ts` | Octokit helpers: `clientForToken(pat)`, `getPullRequest`, `approve`, `postComment`. No installation token; `BOT_PAT` is used directly. |

`parse` and `decide` contain the logic that's easiest to get wrong and are
fully unit-testable without network or a database.

## Webhook flow (`/api/webhook`)

```
issue_comment.created received
  1. Verify X-Hub-Signature-256              → invalid: 401
  2. action == "created" and on a PR?        → no: 200 no-op
  3. body contains TRIGGER_KEYWORD?          → no: 200 no-op
  4. extractMentions() → all @mentions in body
  5. candidates = mentions
        minus the PR author (GitHub forbids self-approval)
  6. fetch PR via BOT_PAT (clientForToken)   → base.ref
  7. SAFEGUARD: base.ref in PROTECTED_BRANCHES?
        → yes: post "🚫 won't auto-approve PRs into `<branch>`", 200 stop
  8. for each candidate:
        registered in DB?  → no: add to "skipped (no PAT)"
        yes: decrypt PAT, approve(clientForToken(pat))
              success → "approved"
              failure → "failed (reason)"   (caught, not fatal)
  9. post ONE summary comment via BOT_PAT, e.g.:
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
  author: string,            // PR author login
  baseRef: string,           // PR base branch
  protectedBranches: string[],
  registeredLogins: string[] // who has a PAT in the DB
}) => {
  blocked: boolean,          // base branch protected
  blockedBranch?: string,
  approveAs: string[],       // registered, non-author
  skippedNoPat: string[],    // mentioned + eligible but no PAT
}
```

Login comparison is case-insensitive (GitHub logins are case-insensitive). The
PR author is always excluded before bucketing into `approveAs` / `skippedNoPat`.
There is no `botMention` field — the keyword check happens in the webhook handler
before `decide` is called.

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
| `WEBHOOK_SECRET` | yes | Verifies webhook signatures |
| `ENCRYPTION_KEY` | yes | 32-byte key (base64/hex) for PAT encryption |
| `SETUP_ACCESS_CODE` | yes | Shared code gating `/api/register` |
| `BOT_PAT` | yes | PAT used to read PRs and post summary comments |
| `DATABASE_URL` | yes | Neon connection string, injected by the Neon integration |
| `PROTECTED_BRANCHES` | no (default `main,master`) | Comma-separated branches the bot refuses |
| `TRIGGER_KEYWORD` | no (default `/approve-as`) | The keyword phrase that triggers the bot |

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

1. **Create the Vercel project + Neon DB**: Storage → Create → Neon (injects
   `DATABASE_URL`); run the schema in Neon's SQL editor; do an initial deploy
   to get the domain.
2. **Create a `BOT_PAT`**: a GitHub PAT (user's own or a dedicated machine
   account) with **Pull requests: Read and write** on the target repos. Summary
   comments will appear as this account.
3. **Set env vars** in Vercel: `WEBHOOK_SECRET`, `ENCRYPTION_KEY`,
   `SETUP_ACCESS_CODE`, `BOT_PAT`, `PROTECTED_BRANCHES` (optional),
   `TRIGGER_KEYWORD` (optional). `DATABASE_URL` is injected by the integration.
   Redeploy after setting vars.
4. **Add the webhook**: repo Settings → Webhooks → Add webhook → Payload URL
   `https://<domain>/api/webhook`, Content type `application/json`, Secret =
   `WEBHOOK_SECRET`, "Let me select individual events" → check **Issue comments**
   only. Org-wide: org Settings → Webhooks (needs org admin).
5. **Each teammate registers a PAT:** create a fine-grained PAT scoped to the
   repos with **Pull requests: Read and write**, then visit `/setup`, enter the
   access code + PAT, click Register.
6. **Test:** open a PR into a non-protected branch and comment
   `/approve-as @teammate`.

## Acceptance Criteria

- [ ] Webhook verifies the GitHub signature and rejects invalid ones with 401.
- [ ] Bot triggers only on `issue_comment.created` on a PR whose comment body
      contains the trigger keyword (default `/approve-as`).
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
