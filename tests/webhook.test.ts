import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";

const installClient = { __tag: "install" };
vi.mock("../lib/github", () => ({
  makeApp: vi.fn(() => ({})),
  getInstallationClient: vi.fn(async () => installClient),
  clientForToken: vi.fn((pat: string) => ({ __pat: pat })),
  getPullRequest: vi.fn(async () => ({ author: "alice", baseRef: "feature/x" })),
  approve: vi.fn(async () => {}),
  postComment: vi.fn(async () => {}),
}));
vi.mock("../lib/store", () => ({
  listLogins: vi.fn(async () => ["bob", "carol"]),
  getPat: vi.fn(async (login: string) => `ghp_${login}`),
}));

import handler from "../api/webhook";
import { approve, postComment, getPullRequest } from "../lib/github";

const SECRET = "whsec";

function env() {
  vi.stubEnv("APP_ID", "1");
  vi.stubEnv("APP_PRIVATE_KEY", "k");
  vi.stubEnv("WEBHOOK_SECRET", SECRET);
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("SETUP_ACCESS_CODE", "code");
}

function event(body: string) {
  return {
    action: "created",
    issue: { number: 7, pull_request: {}, user: { login: "alice" } },
    comment: { body },
    repository: { owner: { login: "org" }, name: "repo" },
    installation: { id: 999 },
  };
}

function signedRequest(payload: unknown): Request {
  const raw = JSON.stringify(payload);
  const sig = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  return new Request("https://x/api/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sig,
      "x-github-event": "issue_comment",
    },
    body: raw,
  });
}

describe("webhook handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    env();
  });

  it("rejects a bad signature with 401", async () => {
    const raw = JSON.stringify(event("@pr-approver-bot @bob"));
    const res = await handler(
      new Request("https://x/api/webhook", {
        method: "POST",
        headers: { "x-hub-signature-256": "sha256=bad" },
        body: raw,
      }),
    );
    expect(res.status).toBe(401);
  });

  it("no-ops when the trigger is absent", async () => {
    const res = await handler(signedRequest(event("just chatting @bob")));
    expect(res.status).toBe(200);
    expect(approve).not.toHaveBeenCalled();
  });

  it("approves as each registered tagged user and comments", async () => {
    const res = await handler(signedRequest(event("@pr-approver-bot @bob @carol")));
    expect(res.status).toBe(200);
    expect(approve).toHaveBeenCalledTimes(2);
    expect(postComment).toHaveBeenCalledOnce();
    const summary = (postComment as any).mock.calls[0][4] as string;
    expect(summary).toContain("@bob");
    expect(summary).toContain("@carol");
  });

  it("skips unregistered users in the summary", async () => {
    const res = await handler(signedRequest(event("@pr-approver-bot @bob @dan")));
    expect(approve).toHaveBeenCalledTimes(1);
    const summary = (postComment as any).mock.calls[0][4] as string;
    expect(summary).toContain("@dan");
    expect(summary.toLowerCase()).toContain("no pat");
  });

  it("refuses protected base branch without approving", async () => {
    (getPullRequest as any).mockResolvedValueOnce({ author: "alice", baseRef: "main" });
    const res = await handler(signedRequest(event("@pr-approver-bot @bob")));
    expect(res.status).toBe(200);
    expect(approve).not.toHaveBeenCalled();
    const summary = (postComment as any).mock.calls[0][4] as string;
    expect(summary.toLowerCase()).toContain("main");
  });

  it("reports a per-user approval failure but still approves others", async () => {
    (approve as any)
      .mockRejectedValueOnce(new Error("401"))
      .mockResolvedValueOnce(undefined);
    const res = await handler(signedRequest(event("@pr-approver-bot @bob @carol")));
    expect(res.status).toBe(200);
    expect(approve).toHaveBeenCalledTimes(2);
    const summary = (postComment as any).mock.calls[0][4] as string;
    expect(summary).toMatch(/@bob|@carol/);
  });
});
