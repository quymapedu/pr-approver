import { describe, it, expect, vi } from "vitest";
import {
  getPullRequest,
  approve,
  postComment,
  getAuthenticatedLogin,
} from "../lib/github";

function fakeClient() {
  return {
    rest: {
      pulls: {
        get: vi.fn(async () => ({
          data: { user: { login: "Alice" }, base: { ref: "feature/x" } },
        })),
        createReview: vi.fn(async () => ({ data: {} })),
      },
      issues: { createComment: vi.fn(async () => ({ data: {} })) },
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

  it("postComment posts to the issue", async () => {
    const c = fakeClient();
    await postComment(c as any, "o", "r", 5, "hi");
    expect(c.rest.issues.createComment).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      issue_number: 5,
      body: "hi",
    });
  });

  it("getAuthenticatedLogin returns the token's login", async () => {
    const c = fakeClient();
    expect(await getAuthenticatedLogin(c as any)).toBe("Bob");
  });
});
