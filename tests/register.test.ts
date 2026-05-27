import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/store", () => ({
  putPat: vi.fn(async () => {}),
  delPat: vi.fn(async () => {}),
}));
vi.mock("../lib/github", () => ({
  clientForToken: vi.fn(() => ({})),
  getAuthenticatedLogin: vi.fn(async () => "Bob"),
}));

import handler from "../api/register";
import { putPat, delPat } from "../lib/store";
import { getAuthenticatedLogin } from "../lib/github";

function env() {
  vi.stubEnv("APP_ID", "1");
  vi.stubEnv("APP_PRIVATE_KEY", "k");
  vi.stubEnv("WEBHOOK_SECRET", "w");
  vi.stubEnv("ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("SETUP_ACCESS_CODE", "letmein");
}

function post(body: unknown): Request {
  return new Request("https://x/api/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("register handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    env();
  });

  it("rejects a wrong access code with 403", async () => {
    const res = await handler(post({ action: "register", accessCode: "nope", pat: "ghp_x" }));
    expect(res.status).toBe(403);
    expect(putPat).not.toHaveBeenCalled();
  });

  it("rejects an invalid PAT with 401", async () => {
    (getAuthenticatedLogin as any).mockRejectedValueOnce(new Error("bad"));
    const res = await handler(post({ action: "register", accessCode: "letmein", pat: "bad" }));
    expect(res.status).toBe(401);
    expect(putPat).not.toHaveBeenCalled();
  });

  it("registers a PAT under the verified login", async () => {
    const res = await handler(post({ action: "register", accessCode: "letmein", pat: "ghp_x" }));
    expect(res.status).toBe(200);
    expect(putPat).toHaveBeenCalledWith("Bob", "ghp_x", expect.any(Buffer));
    expect(await res.json()).toMatchObject({ login: "Bob" });
  });

  it("removes a PAT", async () => {
    const res = await handler(post({ action: "remove", accessCode: "letmein", pat: "ghp_x" }));
    expect(res.status).toBe(200);
    expect(delPat).toHaveBeenCalledWith("Bob");
  });

  it("405s on non-POST", async () => {
    const res = await handler(new Request("https://x/api/register", { method: "GET" }));
    expect(res.status).toBe(405);
  });
});
