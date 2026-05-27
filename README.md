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
