# Context-aware approval — design

**Date:** 2026-06-08
**Status:** Approved, pending implementation

## Goal

Let a reviewer approve a PR by mentioning the bot in the PR's Slack thread with
no PR number and no self-tag — ultimately just:

```
@Approver approve this PR
```

Today the same approval requires the reviewer to type the PR number and tag
themselves: `@Approver 1183 @Quý`. Both of those become optional.

## Behavior

The bot is mentioned **in the Slack thread under a GitHub PR notification**.
Two independent rules, each a fallback that never overrides an explicit signal:

- **PR reference** — if the mention text contains no PR ref, resolve the PR from
  the thread.
- **Reviewer** — if the mention tags nobody (besides the bot), approve as the
  person who sent the mention.

| Mention (in a PR thread)        | PR resolved from   | Approves as              |
|---------------------------------|--------------------|--------------------------|
| `@Approver approve this PR`     | thread context     | sender                   |
| `@Approver 1183`                | explicit (`1183`)  | sender                   |
| `@Approver approve @Duc`        | thread context     | Duc (tagged replaces sender) |
| `@Approver 1183 @Duc`           | explicit           | Duc                      |

Explicit always wins: an explicit PR ref is used even inside a thread, and
explicitly tagged reviewers replace the sender default.

## Changes

### 1. Approve as the sender (`api/slack.ts`)

- Capture `event.user` (the mention's sender) from the Slack event — currently
  parsed out and dropped.
- After collecting tagged user IDs and removing the bot's own ID: if the list is
  empty, use `[event.user]`.
- `decide()` is unchanged. It already excludes the PR author, so if the sender
  *is* the author the approval is a no-op for them — and GitHub blocks
  self-approval regardless.

### 2. Resolve the PR from the thread (new `lib/slack-thread.ts` + wiring)

Runs only when **both**:
- `parsePrRef(text)` returns `null` (no PR ref in the mention itself), and
- the mention is inside a thread (`event.thread_ts` is set).

Steps:
1. Call Slack `conversations.replies(channel, ts = thread_ts)` to fetch the
   thread's messages.
2. Scan messages **root-first**. The thread root is GitHub's "Pull request
   opened" notification, i.e. the PR the thread is about, so it is the most
   trustworthy source. First match wins.
3. For each message, run `parsePrRef` over a combined string built from the
   message text **and** its attachments/blocks. GitHub puts the PR URL in
   `attachments[].title_link` (not the visible `text`), so the helper gathers:
   `message.text`, each attachment's `title_link` / `title` / `fallback` / `text`,
   and a stringified `blocks` fallback.
4. If nothing matches, behavior is unchanged: the existing "I couldn't find a
   PR" reply fires.

`parsePrRef` and `resolveTarget` are reused as-is — the thread scan only
*produces* a `PrRef`, it does not change how a ref is resolved to a PR.

## New Slack scope (setup change)

Reading thread messages needs a history scope the app does not have yet:

- `channels:history` — public channels
- `groups:history` — private channels

These are added in the Slack app's OAuth & Permissions and require reinstalling
the app to the workspace. The bot token is otherwise unchanged. README updated
to document the new scopes.

## Testing

- **Thread scan** (`lib/slack-thread.ts`): extracts the PR URL from a realistic
  GitHub-app message (URL in `attachments[].title_link`); prefers the root
  message over PRs mentioned in replies; returns `null` when no ref is present.
- **Sender fallback** (`api/slack.ts` parsing): empty tag list → `[sender]`;
  non-empty tag list → unchanged (sender not added).
- The `conversations.replies` fetch is mocked the way `slack-api.test.ts`
  already mocks `chat.postMessage`.

## Out of scope

- Scanning top-level (non-threaded) channel history for a PR. The bot only
  looks inside the thread it was mentioned in.
- Choosing the "most recent" PR in a thread over the root — we always trust the
  thread root.
