import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  messageSearchText,
  extractPrRef,
  resolvePrFromThread,
  resolvePrFromChannel,
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

  it("skips the bot's own messages so its usage hint can't poison resolution", () => {
    // The bot's hint literally contains an example number (1164). With the bot's
    // user id supplied, that message must be ignored and the real human mention win.
    expect(
      extractPrRef(
        [
          { user: "U_HUMAN", text: "@approver approve thsi" },
          { user: "U_BOT", text: "e.g. @approver 1164 @bob" },
          { user: "U_HUMAN", text: "@approver 1186 @duc" },
        ],
        OWNER,
        { userId: "U_BOT" },
      ),
    ).toEqual({ owner: OWNER, repo: null, number: 1186 });
  });

  it("identifies the bot's own messages by bot_id when no user field is set", () => {
    // Slack stamps a bot's posts with bot_id; the `user` field may be absent
    // (the bot_message subtype). Resolution must still exclude them — here the
    // bot's earlier hint carries a bare number and only bot_id identifies it.
    expect(
      extractPrRef(
        [
          { bot_id: "B_SELF", text: "e.g. @approver 1164 @bob" },
          { user: "U_HUMAN", text: "@approver 1186 @duc" },
        ],
        OWNER,
        { botId: "B_SELF" },
      ),
    ).toEqual({ owner: OWNER, repo: null, number: 1186 });
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

describe("resolvePrFromChannel", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("resolves when channel history holds exactly one PR notification", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          messages: [
            { user: "U_HUMAN", text: "@approver approve" },
            {
              text: "Pull request opened by Kien",
              attachments: [{ title_link: "https://github.com/org/repo/pull/1186" }],
            },
          ],
        }),
      ),
    );

    const res = await resolvePrFromChannel("xoxb-test", "C123", "mapEDU-AI");

    expect(res).toEqual({ kind: "found", ref: { owner: "org", repo: "repo", number: 1186 } });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("conversations.history");
    expect(url).toContain("channel=C123");
  });

  it("refuses to guess when history holds multiple distinct PRs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          messages: [
            {
              text: "Pull request opened by Kien",
              attachments: [{ title_link: "https://github.com/org/repo/pull/1186" }],
            },
            {
              text: "Pull request opened earlier",
              attachments: [{ title_link: "https://github.com/org/repo/pull/1180" }],
            },
          ],
        }),
      ),
    );

    const res = await resolvePrFromChannel("xoxb-test", "C123", "mapEDU-AI");

    expect(res).toEqual({
      kind: "ambiguous",
      candidates: [
        { owner: "org", repo: "repo", number: 1186 },
        { owner: "org", repo: "repo", number: 1180 },
      ],
    });
  });

  it("treats repeated notifications for the same PR as one candidate", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          messages: [
            { attachments: [{ title_link: "https://github.com/org/repo/pull/1186" }] },
            { attachments: [{ title_link: "https://github.com/org/repo/pull/1186" }] },
          ],
        }),
      ),
    );

    const res = await resolvePrFromChannel("xoxb-test", "C123", "mapEDU-AI");
    expect(res).toEqual({ kind: "found", ref: { owner: "org", repo: "repo", number: 1186 } });
  });

  it("ignores bare numbers in chat — only fully-qualified PR notifications count", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          messages: [{ user: "U_HUMAN", text: "ship 1186 please" }],
        }),
      ),
    );

    const res = await resolvePrFromChannel("xoxb-test", "C123", "mapEDU-AI");
    expect(res).toEqual({ kind: "none" });
  });

  it("excludes the bot's own messages (by bot_id) that carry a full PR URL", async () => {
    // A bot message that parses to a fully-qualified PR must not become a
    // candidate, or the bot would re-ingest its own posts and turn a single real
    // PR into a false "multiple PRs" ambiguity. Identified by bot_id, no user.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          messages: [
            { bot_id: "B_SELF", text: "earlier I approved github.com/org/repo/pull/7" },
            {
              text: "Pull request opened by Kien",
              attachments: [{ title_link: "https://github.com/org/repo/pull/1186" }],
            },
          ],
        }),
      ),
    );

    const res = await resolvePrFromChannel("xoxb-test", "C123", "mapEDU-AI", {
      botId: "B_SELF",
    });
    // Without bot_id filtering this would be { kind: "ambiguous", [#7, #1186] }.
    expect(res).toEqual({ kind: "found", ref: { owner: "org", repo: "repo", number: 1186 } });
  });

  it("anchors history to the mention timestamp via latest", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, messages: [] })),
    );

    await resolvePrFromChannel("xoxb-test", "C123", "mapEDU-AI", { userId: "U_BOT" }, "170.500");

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("latest=170.500");
  });

  it("reports none when Slack responds not-ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: false, error: "not_in_channel" })),
    );
    expect(await resolvePrFromChannel("xoxb-test", "C123", "mapEDU-AI")).toEqual({
      kind: "none",
    });
  });
});
