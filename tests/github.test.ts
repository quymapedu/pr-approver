import { describe, it, expect, vi } from "vitest";
import {
  getPullRequest,
  tryGetPullRequest,
  approve,
  getAuthenticatedLogin,
} from "../lib/github";

function fakeClient() {
  return {
    rest: {
      pulls: {
        get: vi.fn(async () => ({
          data: {
            user: { login: "Alice" },
            base: { ref: "feature/x" },
            state: "open",
          },
        })),
        createReview: vi.fn(async () => ({ data: {} })),
      },
      users: {
        getAuthenticated: vi.fn(async () => ({ data: { login: "Bob" } })),
      },
    },
  };
}

describe("github helpers", () => {
  it("getPullRequest returns author + baseRef", async () => {
    const c = fakeClient();
    const pr = await getPullRequest(c as any, "o", "r", 5);
    expect(pr).toEqual({ author: "Alice", baseRef: "feature/x" });
    expect(c.rest.pulls.get).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      pull_number: 5,
    });
  });

  it("tryGetPullRequest returns metadata including state", async () => {
    const c = fakeClient();
    const pr = await tryGetPullRequest(c as any, "o", "r", 5);
    expect(pr).toEqual({ author: "Alice", baseRef: "feature/x", state: "open" });
  });

  it("tryGetPullRequest returns null on a 404", async () => {
    const c = fakeClient();
    c.rest.pulls.get = vi.fn(async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });
    expect(await tryGetPullRequest(c as any, "o", "r", 5)).toBeNull();
  });

  it("tryGetPullRequest rethrows non-404 errors", async () => {
    const c = fakeClient();
    c.rest.pulls.get = vi.fn(async () => {
      throw Object.assign(new Error("boom"), { status: 500 });
    });
    await expect(tryGetPullRequest(c as any, "o", "r", 5)).rejects.toThrow("boom");
  });

  it("approve submits an APPROVE review", async () => {
    const c = fakeClient();
    await approve(c as any, "o", "r", 5);
    expect(c.rest.pulls.createReview).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      pull_number: 5,
      event: "APPROVE",
    });
  });

  it("getAuthenticatedLogin returns the token's login", async () => {
    const c = fakeClient();
    expect(await getAuthenticatedLogin(c as any)).toBe("Bob");
  });
});
