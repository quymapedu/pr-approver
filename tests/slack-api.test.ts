import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("@vercel/functions", () => ({
  // run the work synchronously so tests can await its effects
  waitUntil: (p: Promise<unknown>) => p,
}));
vi.mock("../lib/github", () => ({
  clientForToken: vi.fn((pat: string) => ({ __pat: pat })),
  getPullRequest: vi.fn(async () => ({ author: "alice", baseRef: "feature/x" })),
  tryGetPullRequest: vi.fn(async () => ({
    author: "alice",
    baseRef: "feature/x",
    state: "open",
  })),
  approve: vi.fn(async () => {}),
}));
vi.mock("../lib/store", () => ({
  listLogins: vi.fn(async () => ["bob", "carol"]),
  getPat: vi.fn(async (login: string) => `ghp_${login}`),
  getLoginForSlack: vi.fn(async (id: string) =>
    ({ U01BOB: "bob", U01CAROL: "carol" } as Record<string, string>)[id] ?? null,
  ),
}));

import { handler, processApproval } from "../api/slack";
import { approve, getPullRequest, tryGetPullRequest } from "../lib/github";
import { getPat } from "../lib/store";
import type { Config } from "../lib/config";

const SECRET = "slacksecret";

function env() {
  vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("SETUP_ACCESS_CODE", "code");
}

const cfg: Config = {
  slackSigningSecret: SECRET,
  slackBotToken: "xoxb-test",
  encryptionKey: Buffer.alloc(32, 1),
  setupAccessCode: "code",
  protectedBranches: ["main", "master"],
  defaultOwner: "mapEDU-AI",
  repos: ["mapedu-be", "mapedu-fe"],
};

const PR = "https://github.com/org/repo/pull/7";

// Sign an arbitrary raw body the way Slack does (used for events + handshake).
function signed(rawBody: string, retryNum?: string): Request {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig =
    "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${rawBody}`).digest("hex");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-slack-signature": sig,
    "x-slack-request-timestamp": ts,
    host: "approver.vercel.app",
  };
  if (retryNum) headers["x-slack-retry-num"] = retryNum;
  return new Request("https://approver.vercel.app/api/slack", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

// Build a signed app_mention event request.
function mention(text: string, opts: { botUserId?: string } = {}): Request {
  const body = JSON.stringify({
    type: "event_callback",
    authorizations: [{ user_id: opts.botUserId ?? "U0BOT" }],
    event: {
      type: "app_mention",
      text,
      channel: "C123",
      ts: "1700000000.000100",
    },
  });
  return signed(body);
}

describe("processApproval", () => {
  beforeEach(() => vi.clearAllMocks());

  it("approves resolved + registered reviewers", async () => {
    const summary = await processApproval({
      ref: { owner: "org", repo: "repo", number: 7 },
      slackUserIds: ["U01BOB", "U01CAROL"],
      cfg,
      appBaseUrl: "",
    });
    expect(approve).toHaveBeenCalledTimes(2);
    expect(summary).toContain("@bob");
    expect(summary).toContain("@carol");
    // PR number rendered as a Slack link to the PR.
    expect(summary).toContain("<https://github.com/org/repo/pull/7|#7>");
  });

  it("reports unlinked Slack users", async () => {
    const summary = await processApproval({
      ref: { owner: "org", repo: "repo", number: 7 },
      slackUserIds: ["U01BOB", "U01STRANGER"],
      cfg,
      appBaseUrl: "",
    });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(summary).toContain("<@U01STRANGER>");
    expect(summary.toLowerCase()).toContain("not linked");
  });

  it("refuses a protected base branch without approving", async () => {
    (getPullRequest as any).mockResolvedValueOnce({ author: "alice", baseRef: "main" });
    const summary = await processApproval({
      ref: { owner: "org", repo: "repo", number: 7 },
      slackUserIds: ["U01BOB"],
      cfg,
      appBaseUrl: "",
    });
    expect(approve).not.toHaveBeenCalled();
    expect(summary.toLowerCase()).toContain("main");
  });

  it("approves a protected base branch when skipProtected is set", async () => {
    (getPullRequest as any).mockResolvedValueOnce({ author: "alice", baseRef: "main" });
    const summary = await processApproval({
      ref: { owner: "org", repo: "repo", number: 7 },
      slackUserIds: ["U01BOB"],
      cfg,
      appBaseUrl: "",
      skipProtected: true,
    });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(summary).toContain("@bob");
  });

  it("returns a usage hint when no PR reference", async () => {
    const summary = await processApproval({
      ref: null,
      slackUserIds: ["U01BOB"],
      cfg,
      appBaseUrl: "",
    });
    expect(approve).not.toHaveBeenCalled();
    expect(summary.toLowerCase()).toContain("@approver");
  });

  it("builds clickable /setup links from appBaseUrl", async () => {
    (getPat as any).mockResolvedValueOnce(null); // nobody has a PAT
    const summary = await processApproval({
      ref: { owner: "org", repo: "repo", number: 7 },
      slackUserIds: ["U01BOB"],
      cfg,
      appBaseUrl: "https://approver.vercel.app",
    });
    expect(summary).toContain("https://approver.vercel.app/setup");
  });

  it("resolves a bare number to the one repo with an open PR", async () => {
    (tryGetPullRequest as any).mockImplementation(async (_c: unknown, _o: string, repo: string) =>
      repo === "mapedu-be"
        ? { author: "alice", baseRef: "feature/x", state: "open" }
        : null,
    );
    const summary = await processApproval({
      ref: { owner: "mapEDU-AI", repo: null, number: 1164 },
      slackUserIds: ["U01BOB"],
      cfg,
      appBaseUrl: "",
    });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith(
      expect.anything(),
      "mapEDU-AI",
      "mapedu-be",
      1164,
    );
    expect(summary).toContain("@bob");
  });

  it("asks to disambiguate a bare number open in multiple repos", async () => {
    (tryGetPullRequest as any).mockImplementation(async () => ({
      author: "alice",
      baseRef: "feature/x",
      state: "open",
    }));
    const summary = await processApproval({
      ref: { owner: "mapEDU-AI", repo: null, number: 1164 },
      slackUserIds: ["U01BOB"],
      cfg,
      appBaseUrl: "",
    });
    expect(approve).not.toHaveBeenCalled();
    expect(summary.toLowerCase()).toContain("multiple repos");
  });

  it("reports not found when a bare number matches no open PR", async () => {
    (tryGetPullRequest as any).mockImplementation(async () => null);
    const summary = await processApproval({
      ref: { owner: "mapEDU-AI", repo: null, number: 999 },
      slackUserIds: ["U01BOB"],
      cfg,
      appBaseUrl: "",
    });
    expect(approve).not.toHaveBeenCalled();
    expect(summary.toLowerCase()).toContain("couldn't find");
  });

  it("asks reviewers to register when none have a stored PAT", async () => {
    (getPat as any).mockResolvedValueOnce(null); // bob has no PAT
    const summary = await processApproval({
      ref: { owner: "org", repo: "repo", number: 7 },
      slackUserIds: ["U01BOB"],
      cfg,
      appBaseUrl: "",
    });
    expect(getPullRequest).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    expect(summary).toContain("/setup");
  });

  it("points to /setup when the reviewer's token can't read the PR", async () => {
    (getPullRequest as any).mockRejectedValueOnce(
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    const summary = await processApproval({
      ref: { owner: "org", repo: "repo", number: 7 },
      slackUserIds: ["U01BOB"],
      cfg,
      appBaseUrl: "",
    });
    expect(approve).not.toHaveBeenCalled();
    expect(summary).toContain("/setup");
  });
});

describe("slack events handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    env();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true })),
    );
  });

  it("answers the url_verification challenge", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const res = await handler(signed(body));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("abc123");
  });

  it("rejects a bad signature with 401", async () => {
    const body = JSON.stringify({ type: "event_callback" });
    const ts = Math.floor(Date.now() / 1000).toString();
    const res = await handler(
      new Request("https://approver.vercel.app/api/slack", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-signature": "v0=bad",
          "x-slack-request-timestamp": ts,
        },
        body,
      }),
    );
    expect(res.status).toBe(401);
    expect(approve).not.toHaveBeenCalled();
  });

  it("approves on app_mention and posts a threaded reply", async () => {
    const res = await handler(mention(`<@U0BOT> ${PR} <@U01BOB> <@U01CAROL>`));
    expect(res.status).toBe(200);
    expect(approve).toHaveBeenCalledTimes(2);

    const fetchMock = globalThis.fetch as any;
    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({ method: "POST" }),
    );
    const posted = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(posted.channel).toBe("C123");
    expect(posted.thread_ts).toBe("1700000000.000100");
    expect(posted.text).toContain("@bob");
  });

  it("bypasses the protected-branch block when the mention carries the flag", async () => {
    (getPullRequest as any).mockResolvedValueOnce({ author: "alice", baseRef: "main" });
    const res = await handler(
      mention(`<@U0BOT> ${PR} <@U01BOB> --dangerously-skip-permissions`),
    );
    expect(res.status).toBe(200);
    expect(approve).toHaveBeenCalledTimes(1);
    const posted = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body as string);
    expect(posted.text).toContain("@bob");
  });

  it("does not treat the bot's own mention as a reviewer", async () => {
    const summary = await handler(mention(`<@U0BOT> ${PR} <@U01BOB>`));
    expect(summary.status).toBe(200);
    // Only bob is approved; U0BOT is filtered out.
    expect(approve).toHaveBeenCalledTimes(1);
    const posted = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body as string);
    expect(posted.text).not.toContain("U0BOT");
  });

  it("ignores Slack retries without reprocessing", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      authorizations: [{ user_id: "U0BOT" }],
      event: { type: "app_mention", text: `${PR} <@U01BOB>`, channel: "C1", ts: "1.1" },
    });
    const res = await handler(signed(body, "1"));
    expect(res.status).toBe(200);
    expect(approve).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns a clean 500 when SLACK_SIGNING_SECRET is missing", async () => {
    vi.stubEnv("SLACK_SIGNING_SECRET", "");
    const res = await handler(mention(`${PR} <@U01BOB>`));
    expect(res.status).toBe(500);
  });
});
