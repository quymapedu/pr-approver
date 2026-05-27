# Slack-Triggered PR Approver — Design

**Date:** 2026-05-27
**Status:** Approved (design)

> **Supersedes** the webhook/keyword design in
> `2026-05-27-pr-approver-bot-design.md`. The bot is now triggered **solely
> from Slack**; the GitHub repo-comment trigger and its supporting code are
> removed.

## Purpose

A Slack slash command that approves a GitHub pull request on behalf of tagged
reviewers, using each reviewer's own registered Personal Access Token (PAT).

Usage in Slack:

```
/approve-as https://github.com/org/repo/pull/123 @bob @carol
```

The bot resolves each @-mentioned Slack user to their linked GitHub login,
then submits an approving review **as each of them** using their registered
PAT, and replies in Slack with a summary.

The bot exists to remove friction in a small, mutually-trusting team. It is not
a security control and deliberately bypasses the human step of review — every
participant registers their own PAT and links their own Slack account
knowingly. The one hard safeguard is that the bot **never** approves PRs
targeting protected branches (default `main`, `master`).

## Scope

In scope:
- A Slack slash-command endpoint that approves a PR as the tagged, registered,
  non-author reviewers.
- A self-service `/setup` page where teammates register/remove their PAT and
  (optionally) link their Slack member ID.
- Encrypted-at-rest PAT storage + a Slack-user → GitHub-login mapping in Neon.
- The protected-branch safeguard.

Out of scope (YAGNI):
- The GitHub repo-comment trigger (removed — Slack is the sole entry point).
- Posting results as a GitHub PR comment (results go to Slack only).
- Slack interactive components / buttons / modals — a slash command only.
- A Slack bot token / `users.info` lookups — Slack user IDs come from the
  escaped command text; the Slack→GitHub link is established at `/setup`.
- Requesting changes / dismissing reviews — approve only.

## What is removed (from the prior design)

- `api/webhook.ts` and `tests/webhook.test.ts` — the GitHub comment trigger.
- `lib/verify.ts` (GitHub HMAC) and `lib/parse.ts`
  (`extractMentions`/`containsKeyword`) — now dead.
- `postComment` from `lib/github.ts` — results post to Slack, not a PR comment.
- Env vars `WEBHOOK_SECRET` and `TRIGGER_KEYWORD`.

## Hosting & stack

- **Vercel free tier**, Node serverless functions (Fetch-API handlers).
- **TypeScript.**
- **Neon** (serverless Postgres) via `@neondatabase/serverless`.
- **Octokit** (`octokit`) — `clientForToken(pat)` per reviewer + a `BOT_PAT`
  client to read the PR.
- **`@vercel/functions`** — `waitUntil` to finish GitHub work after the fast
  Slack ack.
- Node `crypto` for AES-256-GCM and Slack signature verification.
- Tests: **Vitest**.

## Architecture

| File | Responsibility |
|---|---|
| `api/slack.ts` | Slack slash-command entry: verify signature, parse, ack in <3s, run approval via `waitUntil`, post summary to `response_url`. |
| `api/register.ts` | `/setup` backend: verify access code + PAT, upsert/remove PAT and (optional) Slack link. |
| `public/setup.html` | Static form: access code, PAT, optional Slack member ID; Register/Remove. |
| `lib/config.ts` | Load + validate env into typed `Config`. |
| `lib/slack.ts` | **Pure**: `verifySlackSignature`, `parsePrUrl`, `parseSlackUserIds`. |
| `lib/decide.ts` | **Pure** approve/skip/block decision (unchanged). |
| `lib/store.ts` | Neon: `pats` (PAT) + `slack_links` (Slack→login) read/write. |
| `lib/crypto.ts` | AES-256-GCM encrypt/decrypt (unchanged). |
| `lib/github.ts` | `clientForToken`, `getPullRequest`, `approve`, `getAuthenticatedLogin`. |

`slack.ts` and `decide.ts` hold the logic that's easiest to get wrong and are
fully unit-testable without network or a database.

## Slack request flow (`/api/slack`)

Slack sends `application/x-www-form-urlencoded` with headers
`X-Slack-Signature` and `X-Slack-Request-Timestamp`.

```
1. Read raw body (req.text()).
2. verifySlackSignature(rawBody, timestamp, signature, SLACK_SIGNING_SECRET)
      basestring = `v0:{timestamp}:{rawBody}`
      expected   = "v0=" + HMAC_SHA256(secret, basestring)  (hex)
      constant-time compare; reject if |now - timestamp| > 300s (replay)
   → invalid: 401
3. Parse form → `text`, `response_url`.
4. parsePrUrl(text) → {owner, repo, number} | null
   parseSlackUserIds(text) → ["U123", ...]   (from <@U123|name> tokens)
5. ACK immediately: 200 JSON { response_type: "ephemeral", text: "⏳ Working…" }
6. waitUntil( processApproval(...) → POST summary to response_url )
```

`SLACK_SIGNING_SECRET` missing → clean 500 ("configuration error"). The Slack
slash command must have **"Escape channels, users, and links"** enabled so
`@bob` arrives as `<@U123|bob>`.

## Approval core (`processApproval`, testable)

```
processApproval({ pr, slackUserIds, cfg }) -> summaryText
  - pr == null → "Couldn't find a GitHub PR URL in your command."
  - resolve each slackUserId via store.getLoginForSlack:
        mapped   → collect login
        unmapped → collect for "not linked" report (echo <@id> so Slack renders the name)
  - botClient = clientForToken(cfg.botPat)
  - { author, baseRef } = getPullRequest(botClient, owner, repo, number)
  - result = decide({ mentions: resolvedLogins, author, baseRef,
                      protectedBranches: cfg.protectedBranches,
                      registeredLogins: await listLogins() })
  - if result.blocked → "🚫 won't approve PRs into `<branch>`"
  - for each result.approveAs:
        pat = getPat(login); if null → failed "token missing"
        approve(clientForToken(pat), owner, repo, number)
        success → approved;  catch → failed (reason)   [per-user isolation]
  - summary lines: ✅ Approved as @… · ⚠️ Skipped @… (no PAT, /setup)
                   · ⚠️ Not linked: <@…> (/setup) · ❌ @… — reason
```

The Slack reply posts to `response_url` with `response_type: "in_channel"`
(visible approval record).

## Identity linking (`/setup` + `/api/register`)

`POST /api/register` body: `{ action: "register"|"remove", accessCode, pat, slackUserId? }`

```
1. accessCode constant-time match SETUP_ACCESS_CODE → no: 403
2. GET /user with pat → login   (invalid: 401)
3. register: putPat(login, encrypt(pat)); if slackUserId: putSlackLink(slackUserId, login)  → 200
   remove:   delPat(login);             if slackUserId: delSlackLink(slackUserId)           → 200
```

The PAT proves the GitHub login in the same request, so linking
`slackUserId → login` is self-verified (you can only link your Slack ID to a
GitHub account whose token you hold). `public/setup.html` gains an optional
"Slack member ID" field (users copy it from their Slack profile → ⋮ → Copy
member ID).

## Storage

Two tables in Neon:

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

`store` functions: `putPat`/`getPat`/`delPat`/`listLogins` (existing) plus
`putSlackLink(slackUserId, login)`, `getLoginForSlack(slackUserId)`,
`delSlackLink(slackUserId)`. PATs encrypted with AES-256-GCM; the Slack→login
map is not secret (just an identifier mapping).

## Configuration (env vars)

| Var | Required | Purpose |
|---|---|---|
| `SLACK_SIGNING_SECRET` | yes | Verify Slack slash-command requests |
| `BOT_PAT` | yes | Read the PR (base branch + author) |
| `ENCRYPTION_KEY` | yes | 32-byte key (hex/base64) for PAT encryption |
| `SETUP_ACCESS_CODE` | yes | Shared code gating `/api/register` |
| `DATABASE_URL` | yes | Neon, injected by the integration |
| `PROTECTED_BRANCHES` | no (default `main,master`) | Branches the bot refuses |

`Config`: `slackSigningSecret`, `botPat`, `encryptionKey`, `setupAccessCode`,
`protectedBranches`. (No `webhookSecret`, no `triggerKeyword`.)

## Error handling

- Bad/stale Slack signature → **401**.
- Missing `SLACK_SIGNING_SECRET` / required env → clean **500** ("configuration error").
- No PR URL, unresolvable Slack user, protected branch, unregistered login,
  per-PAT approve failure → all reported in the Slack summary, never a crash.
- `/api/register`: wrong access code → 403; invalid PAT → 401; DB failure → 500.

## Testing

Vitest unit tests:
- `slack`: signature valid / wrong / missing header / stale timestamp;
  `parsePrUrl` (valid URL, no URL, extra text); `parseSlackUserIds`
  (`<@U1|a> <@U2>`, none, dedupe).
- `processApproval`: approves resolved+registered reviewers; protected-branch
  block (no approve); unmapped Slack user reported; unregistered login skipped;
  per-user failure isolated; no PR URL.
- `store`: `putSlackLink`/`getLoginForSlack`/`delSlackLink` (mocked Neon).
- `register`: Slack-link stored on register when `slackUserId` given; access
  code + PAT-verify paths (existing).
- `config`: required vars incl. `SLACK_SIGNING_SECRET`; defaults.
- `crypto`: unchanged.

## Setup steps (also README)

1. **Vercel + Neon**: create the project, add Neon (injects `DATABASE_URL`),
   run both `CREATE TABLE` statements in Neon's SQL editor, deploy to get the
   domain.
2. **Create `BOT_PAT`**: a GitHub PAT (your own or a machine account) with
   **Pull requests: Read** on the target repos (it only reads PRs).
3. **Create a Slack app** (api.slack.com/apps): add a **slash command**
   `/approve-as` → Request URL `https://<domain>/api/slack`, enable **"Escape
   channels, users, and links"**. Copy the **Signing Secret** (Basic
   Information). Install the app to the workspace.
4. **Set Vercel env vars**: `SLACK_SIGNING_SECRET`, `BOT_PAT`,
   `ENCRYPTION_KEY`, `SETUP_ACCESS_CODE`, optional `PROTECTED_BRANCHES`
   (`DATABASE_URL` auto-injected). Redeploy.
5. **Register + link**: each teammate creates a PAT (**Pull requests: Read and
   write** on the repos), opens `/setup`, enters the access code + PAT + their
   Slack member ID, clicks Register.
6. **Test**: `/approve-as <PR-url> @teammate` into a non-protected branch.

## Acceptance Criteria

- [ ] `/api/slack` verifies the Slack signature (v0 HMAC) and rejects invalid
      or stale (>5 min) requests with 401.
- [ ] The handler acks Slack within 3s and completes the approval via
      `waitUntil`, posting the result to `response_url`.
- [ ] The PR is identified by a GitHub PR URL in the command text.
- [ ] Tagged Slack users are resolved to GitHub logins via `slack_links`;
      unmapped users are reported ("not linked").
- [ ] The bot approves as every resolved, registered, non-author reviewer using
      their PAT.
- [ ] The bot never approves PRs whose base branch is in `PROTECTED_BRANCHES`
      (default `main`, `master`) and says so.
- [ ] Reviewers without a registered PAT are skipped and reported.
- [ ] A per-user approval failure does not prevent the others.
- [ ] `/setup` registers a PAT under the `GET /user` login and, when a Slack
      member ID is given, stores the `slackUserId → login` link.
- [ ] PATs are stored AES-256-GCM encrypted in Neon.
- [ ] The GitHub repo-comment trigger and its code (`api/webhook.ts`,
      `lib/verify.ts`, `lib/parse.ts`, `postComment`) are removed.
- [ ] Unit tests cover `slack`, `processApproval`, `store` links, `config`,
      and `register` linking.
