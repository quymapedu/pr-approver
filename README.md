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
