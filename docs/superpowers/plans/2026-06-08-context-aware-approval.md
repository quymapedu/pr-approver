# Context-aware Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reviewer approve a PR with `@Approver approve this PR` in the PR's Slack thread — resolving the PR from the thread and approving as the sender, with both behaviors as fallbacks that never override an explicit PR ref or explicit reviewer tags.

**Architecture:** Two independent, additive fallbacks in the Slack event handler. (1) If the mention text has no PR ref *and* the mention is inside a thread, fetch the thread via Slack `conversations.replies` and scan it root-first for a GitHub PR URL. (2) If the mention tags no reviewers (besides the bot), default to the sender's Slack user ID. The PR-from-thread logic lives in a new, mostly-pure `lib/slack-thread.ts`; the sender default is a one-line change in the handler. `decide()`, `resolveTarget()`, and `parsePrRef()` are reused unchanged.

**Tech Stack:** TypeScript (ESM, Node 22), Vercel Web Handler, Slack Web API (`conversations.replies`), Vitest.

---

## File Structure

- **Create** `lib/slack-thread.ts` — fetch a thread's messages and extract a `PrRef` from them. Pure extractor (`messageSearchText`, `extractPrRef`) + thin network wrappers (`fetchThreadReplies`, `resolvePrFromThread`).
- **Create** `tests/slack-thread.test.ts` — unit tests for the extractor and the fetch wrapper (global `fetch` mocked).
- **Modify** `api/slack.ts` — capture `event.user`, default reviewers to the sender, and resolve the PR from the thread when the mention omits it.
- **Modify** `tests/slack-api.test.ts` — extend the `mention()` test helper with `user`/`threadTs`; add handler tests for the sender default and thread resolution.
- **Modify** `README.md` — document the two new Slack scopes and the new no-number/no-tag usage.

---

### Task 1: Pure PR-from-messages extractor

**Files:**
- Create: `lib/slack-thread.ts`
- Test: `tests/slack-thread.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/slack-thread.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { messageSearchText, extractPrRef } from "../lib/slack-thread";

const OWNER = "mapEDU-AI";

describe("messageSearchText", () => {
  it("gathers text plus attachment title_link/title/fallback", () => {
    const text = messageSearchText({
      text: "Pull request opened by Kien",
      attachments: [
        {
          title: "#7 fix things",
          title_link: "https://github.com/org/repo/pull/7",
          fallback: "fallback",
        },
      ],
    });
    expect(text).toContain("Pull request opened by Kien");
    expect(text).toContain("https://github.com/org/repo/pull/7");
    expect(text).toContain("#7 fix things");
  });

  it("stringifies blocks as a fallback source", () => {
    const text = messageSearchText({
      blocks: [{ type: "section", text: { text: "github.com/org/repo/pull/9" } }],
    });
    expect(text).toContain("github.com/org/repo/pull/9");
  });
});

describe("extractPrRef", () => {
  it("finds the PR URL the GitHub app hides in attachments[].title_link", () => {
    expect(
      extractPrRef(
        [
          {
            text: "Pull request opened by Kien",
            attachments: [{ title_link: "https://github.com/org/repo/pull/7" }],
          },
        ],
        OWNER,
      ),
    ).toEqual({ owner: "org", repo: "repo", number: 7 });
  });

  it("prefers the root message over PRs mentioned in replies", () => {
    expect(
      extractPrRef(
        [
          { attachments: [{ title_link: "https://github.com/org/repo/pull/100" }] },
          { text: "see also org/repo/pull/200" },
        ],
        OWNER,
      ),
    ).toEqual({ owner: "org", repo: "repo", number: 100 });
  });

  it("returns null when no message carries a PR reference", () => {
    expect(extractPrRef([{ text: "lgtm 👍" }, { text: "merge it" }], OWNER)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack-thread.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/slack-thread"`.

- [ ] **Step 3: Write the minimal implementation**

Create `lib/slack-thread.ts`:

```ts
import { parsePrRef, type PrRef } from "./slack.js";

export interface SlackAttachment {
  title?: string;
  title_link?: string;
  fallback?: string;
  text?: string;
}

export interface SlackMessage {
  text?: string;
  attachments?: SlackAttachment[];
  blocks?: unknown;
}

// Build one searchable string for a message: the visible text plus the places
// the GitHub Slack app hides the PR URL (attachment title_link/title/fallback/
// text), plus a stringified blocks fallback for any other layout.
export function messageSearchText(msg: SlackMessage): string {
  const parts: string[] = [];
  if (msg.text) parts.push(msg.text);
  for (const a of msg.attachments ?? []) {
    if (a.title_link) parts.push(a.title_link);
    if (a.title) parts.push(a.title);
    if (a.fallback) parts.push(a.fallback);
    if (a.text) parts.push(a.text);
  }
  if (msg.blocks) parts.push(JSON.stringify(msg.blocks));
  return parts.join(" ");
}

// Scan messages root-first (conversations.replies returns oldest first, so the
// thread root — GitHub's PR notification — is index 0) for the first parseable
// PR reference.
export function extractPrRef(
  messages: SlackMessage[],
  defaultOwner: string,
): PrRef | null {
  for (const msg of messages) {
    const ref = parsePrRef(messageSearchText(msg), defaultOwner);
    if (ref) return ref;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slack-thread.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/slack-thread.ts tests/slack-thread.test.ts
git commit -m "feat: extract a PR reference from Slack thread messages"
```

---

### Task 2: Thread fetch wrappers

**Files:**
- Modify: `lib/slack-thread.ts`
- Test: `tests/slack-thread.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/slack-thread.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolvePrFromThread } from "../lib/slack-thread";

describe("resolvePrFromThread", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("calls conversations.replies and extracts the PR from the root message", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          messages: [
            {
              text: "Pull request opened by Kien",
              attachments: [{ title_link: "https://github.com/org/repo/pull/7" }],
            },
          ],
        }),
      ),
    );

    const ref = await resolvePrFromThread("xoxb-test", "C123", "170.001", "mapEDU-AI");

    expect(ref).toEqual({ owner: "org", repo: "repo", number: 7 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("conversations.replies");
    expect(url).toContain("channel=C123");
    expect(url).toContain("ts=170.001");
  });

  it("returns null when Slack responds not-ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "not_in_channel" })),
    );
    expect(
      await resolvePrFromThread("xoxb-test", "C123", "170.001", "mapEDU-AI"),
    ).toBeNull();
  });
});
```

Note: keep the existing `import { describe, it, expect } ...` at the top of the file — the duplicate named imports across two `import` statements are valid ESM and Vitest tolerates them. If your linter objects, merge the imports into the file's existing top import line instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack-thread.test.ts`
Expected: FAIL — `resolvePrFromThread is not a function` (not exported yet).

- [ ] **Step 3: Write the minimal implementation**

Append to `lib/slack-thread.ts`:

```ts
// Fetch a thread's messages (oldest first; index 0 is the thread root). Returns
// [] on any Slack error so callers fall back to the normal "no PR found" path.
export async function fetchThreadReplies(
  botToken: string,
  channel: string,
  threadTs: string,
): Promise<SlackMessage[]> {
  const url =
    "https://slack.com/api/conversations.replies" +
    `?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${botToken}` },
  });
  const data = (await res.json()) as {
    ok: boolean;
    messages?: SlackMessage[];
    error?: string;
  };
  if (!data.ok) {
    console.error("conversations.replies failed:", data.error);
    return [];
  }
  return data.messages ?? [];
}

// Resolve a PR reference from the thread the bot was mentioned in.
export async function resolvePrFromThread(
  botToken: string,
  channel: string,
  threadTs: string,
  defaultOwner: string,
): Promise<PrRef | null> {
  const messages = await fetchThreadReplies(botToken, channel, threadTs);
  return extractPrRef(messages, defaultOwner);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slack-thread.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/slack-thread.ts tests/slack-thread.test.ts
git commit -m "feat: fetch a Slack thread and resolve its PR reference"
```

---

### Task 3: Default reviewers to the mention's sender

**Files:**
- Modify: `api/slack.ts` (the `SlackEventBody` interface and the `app_mention` block, ~lines 217-302)
- Test: `tests/slack-api.test.ts` (extend the `mention()` helper; add one test)

- [ ] **Step 1: Write the failing test**

In `tests/slack-api.test.ts`, replace the `mention()` helper (currently ~lines 72-84) with this version that can set `user` and `thread_ts`:

```ts
// Build a signed app_mention event request.
function mention(
  text: string,
  opts: { botUserId?: string; user?: string; threadTs?: string } = {},
): Request {
  const event: Record<string, unknown> = {
    type: "app_mention",
    text,
    channel: "C123",
    ts: "1700000000.000100",
    user: opts.user ?? "U0SENDER",
  };
  if (opts.threadTs) event.thread_ts = opts.threadTs;
  const body = JSON.stringify({
    type: "event_callback",
    authorizations: [{ user_id: opts.botUserId ?? "U0BOT" }],
    event,
  });
  return signed(body);
}
```

Then add this test inside the `describe("slack events handler", ...)` block:

```ts
it("approves as the sender when no reviewer is tagged", async () => {
  const res = await handler(mention(`<@U0BOT> ${PR} approve this`, { user: "U01BOB" }));
  expect(res.status).toBe(200);
  // The sender (bob) is used even though nobody was tagged.
  expect(approve).toHaveBeenCalledTimes(1);
  const posted = JSON.parse((globalThis.fetch as any).mock.calls.at(-1)[1].body as string);
  expect(posted.text).toContain("@bob");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack-api.test.ts -t "approves as the sender"`
Expected: FAIL — `approve` called 0 times (current code derives reviewers only from tags, so an untagged mention has nobody to approve as).

- [ ] **Step 3: Write the minimal implementation**

In `api/slack.ts`, add `user` to the event interface. Change:

```ts
  event?: {
    type?: string;
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
  };
```

to:

```ts
  event?: {
    type?: string;
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
    user?: string;
  };
```

Then in the `app_mention` block, change:

```ts
    const text = event.text ?? "";
    const botUserId = body.authorizations?.[0]?.user_id;
    const ref = parsePrRef(text, cfg.defaultOwner);
    // Drop the bot's own mention so it isn't treated as a reviewer.
    const slackUserIds = parseSlackUserIds(text).filter((id) => id !== botUserId);
```

to:

```ts
    const text = event.text ?? "";
    const botUserId = body.authorizations?.[0]?.user_id;
    const ref = parsePrRef(text, cfg.defaultOwner);
    // Drop the bot's own mention so it isn't treated as a reviewer.
    const tagged = parseSlackUserIds(text).filter((id) => id !== botUserId);
    // No reviewers tagged? Approve as whoever mentioned the bot.
    const slackUserIds = tagged.length ? tagged : event.user ? [event.user] : [];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/slack-api.test.ts`
Expected: PASS — the new test passes and all existing handler tests still pass (tagged mentions are unaffected because `tagged.length` is truthy for them).

- [ ] **Step 5: Commit**

```bash
git add api/slack.ts tests/slack-api.test.ts
git commit -m "feat: default approval to the mention's sender when none tagged"
```

---

### Task 4: Resolve the PR from the thread when the mention omits it

**Files:**
- Modify: `api/slack.ts` (the `app_mention` block's `waitUntil` body, ~lines 283-301)
- Test: `tests/slack-api.test.ts` (add one test)

- [ ] **Step 1: Write the failing test**

Add this test inside `describe("slack events handler", ...)` in `tests/slack-api.test.ts`:

```ts
it("resolves the PR from the thread when the mention omits it", async () => {
  // Branch the fetch mock: thread fetch returns a GitHub-app message, the
  // reply post returns ok.
  (globalThis.fetch as any).mockImplementation((url: string) =>
    Promise.resolve(
      typeof url === "string" && url.includes("conversations.replies")
        ? new Response(
            JSON.stringify({
              ok: true,
              messages: [
                {
                  text: "Pull request opened by Kien",
                  attachments: [{ title_link: "https://github.com/org/repo/pull/7" }],
                },
              ],
            }),
          )
        : new Response(JSON.stringify({ ok: true })),
    ),
  );

  const res = await handler(
    mention("<@U0BOT> approve this PR", {
      user: "U01BOB",
      threadTs: "1700000000.000050",
    }),
  );

  expect(res.status).toBe(200);
  expect(approve).toHaveBeenCalledTimes(1);
  expect(approve).toHaveBeenCalledWith(expect.anything(), "org", "repo", 7);
  const posted = JSON.parse((globalThis.fetch as any).mock.calls.at(-1)[1].body as string);
  expect(posted.text).toContain("<https://github.com/org/repo/pull/7|#7>");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slack-api.test.ts -t "resolves the PR from the thread"`
Expected: FAIL — `approve` called 0 times (the mention has no PR ref and the handler doesn't yet look in the thread, so `ref` is null and `processApproval` returns the usage hint).

- [ ] **Step 3: Write the minimal implementation**

In `api/slack.ts`, add the import near the other `lib/slack.js` import at the top:

```ts
import { resolvePrFromThread } from "../lib/slack-thread.js";
```

Change the `app_mention` block so `ref` is reassignable and resolved from the thread inside `waitUntil`. Change:

```ts
    const ref = parsePrRef(text, cfg.defaultOwner);
```

to:

```ts
    let ref = parsePrRef(text, cfg.defaultOwner);
```

Then change the `waitUntil` body from:

```ts
    await waitUntil(
      (async () => {
        try {
          const summary = await processApproval({ ref, slackUserIds, cfg, appBaseUrl, skipProtected });
          if (channel) await postSlackMessage(cfg.slackBotToken, channel, threadTs, summary);
        } catch (err) {
```

to:

```ts
    await waitUntil(
      (async () => {
        try {
          // No PR in the mention? Look in the thread it was posted in. Replies
          // need a real thread_ts (event.ts is the mention itself, not a thread).
          if (!ref && event.thread_ts && channel) {
            ref = await resolvePrFromThread(
              cfg.slackBotToken,
              channel,
              event.thread_ts,
              cfg.defaultOwner,
            );
          }
          const summary = await processApproval({ ref, slackUserIds, cfg, appBaseUrl, skipProtected });
          if (channel) await postSlackMessage(cfg.slackBotToken, channel, threadTs, summary);
        } catch (err) {
```

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS — all tests green, no type errors.

- [ ] **Step 5: Commit**

```bash
git add api/slack.ts tests/slack-api.test.ts
git commit -m "feat: resolve the PR from the Slack thread when unspecified"
```

---

### Task 5: Document the new scopes and usage

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the trigger example and intro**

In `README.md`, find the opening usage block (the fenced `@approver https://...` example near the top) and add the new shortest form. Replace:

```
@approver https://github.com/org/repo/pull/123 @bob @carol
```

with:

```
@approver https://github.com/org/repo/pull/123 @bob @carol   # explicit
@approver approve this PR                                     # in a PR thread: resolves the PR from the thread, approves as you
```

Then, immediately after the existing sentence that ends "…then replies in-thread with a summary." add this paragraph:

```
When you mention the bot **inside the Slack thread of a GitHub PR notification**
without a PR reference, it reads the thread and uses the PR it's about. And when
you tag no reviewers, it approves as **you** (the person who mentioned it) — so
the shortest form is just `@approver approve this PR`. Tagging reviewers
explicitly still approves as exactly those people instead.
```

- [ ] **Step 2: Update the Slack scopes in setup**

In `README.md`, find the bullet under "Create the Slack app":

```
- **OAuth & Permissions → Bot Token Scopes** → add `app_mentions:read` and
  `chat:write`.
```

Replace it with:

```
- **OAuth & Permissions → Bot Token Scopes** → add `app_mentions:read`,
  `chat:write`, `channels:history`, and `groups:history`. The two `*:history`
  scopes let the bot read a PR thread to find the PR when you don't type its
  number (`groups:history` covers private channels). If you add these to an
  already-installed app, **reinstall to the workspace** to grant them.
```

- [ ] **Step 3: Verify there are no stale references**

Run: `grep -n "app_mentions:read\|channels:history\|groups:history\|approve this PR" README.md`
Expected: the new scopes and usage line appear; no leftover claim that only two scopes are needed.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document thread PR resolution, sender default, and new scopes"
```

---

## Self-Review

**Spec coverage:**
- "PR reference fallback to thread" → Tasks 1, 2 (extract + fetch), Task 4 (wiring). ✓
- "Reviewer fallback to sender" → Task 3. ✓
- "Explicit always wins" → Task 3 (`tagged.length ? tagged : …`) and Task 4 (`if (!ref && …)`). ✓
- "Root-first scan" → Task 1 `extractPrRef` + test "prefers the root message". ✓
- "Scan text + attachments/blocks" → Task 1 `messageSearchText` + tests. ✓
- "Only inside a thread" → Task 4 guard `event.thread_ts`. ✓
- "New Slack scopes + README" → Task 5. ✓
- "Out of scope: top-level channel history" → no task scans channel history; thread-only guard enforces it. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code and exact commands. ✓

**Type consistency:** `PrRef` is imported from `lib/slack.js` and produced unchanged. `SlackMessage`/`SlackAttachment` defined in Task 1 and reused in Task 2. `resolvePrFromThread(botToken, channel, threadTs, defaultOwner)` signature matches its call site in Task 4. `event.user` added to the interface in Task 3 and read in Tasks 3 & 4. `mention()` helper signature `{ botUserId?, user?, threadTs? }` is defined in Task 3 and reused in Task 4. ✓
