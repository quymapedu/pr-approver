import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  messageSearchText,
  extractPrRef,
  resolvePrFromThread,
} from "../lib/slack-thread";

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
