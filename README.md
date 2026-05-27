# PR Approver Bot

A webhook-based bot (hosted on Vercel) that approves a pull request on behalf
of tagged reviewers, using each reviewer's own Personal Access Token.

Write a keyword + reviewer tag in any PR comment:

```
/approve-as @teammate
```

The bot submits an approving review **as `@teammate`** (using their registered
PAT) — for every registered, non-author `@`-mentioned user in the comment.

> **Safeguard:** the bot never approves PRs whose base branch is protected
> (default `main`, `master`). Configure via `PROTECTED_BRANCHES`.

> **Trust note:** anyone who can comment on the PR can cause an approving
> review to be submitted as a colleague who registered a PAT. Use only within
> a trusting team, and rely on branch protection for `main`.

## Setup

### 1. Create the Vercel project + Neon database

- Import this repo into Vercel.
- Add a **Neon** database (Storage → Create → Neon) and connect it to the
  project. This injects `DATABASE_URL` automatically.
- In Neon's SQL editor, create the table once:

  ```sql
  CREATE TABLE IF NOT EXISTS pats (
    login      text PRIMARY KEY,
    ciphertext text NOT NULL
  );
  ```

- Do an initial deploy to get your Vercel domain (`https://<domain>.vercel.app`).

### 2. Create a BOT_PAT

Create a GitHub Personal Access Token that the server will use to read PR
details and post summary comments. This can be your own PAT or a dedicated
machine account's PAT. It needs access to the target repos with:

- **Pull requests: Read and write** (reads the PR base branch; posts the
  summary comment)

> Note: summary comments will appear as whichever GitHub account owns this PAT.

### 3. Set environment variables in Vercel

| Var | Value |
|---|---|
| `WEBHOOK_SECRET` | the secret you also put in the GitHub webhook config |
| `ENCRYPTION_KEY` | 32-byte key: `openssl rand -hex 32` |
| `SETUP_ACCESS_CODE` | a shared code your team uses on `/setup` |
| `BOT_PAT` | PAT used to read PRs and post summary comments |
| `PROTECTED_BRANCHES` | *(optional)* comma list, default `main,master` |
| `TRIGGER_KEYWORD` | *(optional)* trigger phrase, default `/approve-as` |

(`DATABASE_URL` is injected automatically by the Neon integration.)

After setting vars, redeploy so the new values take effect.

### 4. Add the webhook

In each target repo → **Settings → Webhooks → Add webhook**:

- **Payload URL:** `https://<your-domain>/api/webhook`
- **Content type:** `application/json`
- **Secret:** your `WEBHOOK_SECRET` value
- **Which events:** "Let me select individual events" → check **Issue comments** only
- Click **Add webhook**

For org-wide coverage: org **Settings → Webhooks**, same fields — requires org
admin permissions.

### 5. Register reviewer PATs

Each teammate:

1. Creates a fine-grained PAT scoped to the target repos with
   **Pull requests: Read and write**.
2. Visits `https://<your-domain>/setup`.
3. Enters the access code + PAT and clicks **Register**.

To revoke: same page, click **Remove** (or delete the PAT on GitHub).

### 6. Test

Open a PR into a non-protected branch and comment:

```
/approve-as @teammate
```

The bot replies with a summary of who it approved as.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```
