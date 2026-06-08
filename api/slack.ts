import { waitUntil } from "@vercel/functions";
import { loadConfig, type Config } from "../lib/config.js";
import {
  verifySlackSignature,
  parsePrRef,
  parseSlackUserIds,
  parseSkipPermissions,
  type PrRef,
} from "../lib/slack.js";
import { decide } from "../lib/decide.js";
import {
  resolvePrFromThread,
  resolvePrFromChannel,
  fetchBotIdentity,
} from "../lib/slack-thread.js";
import { listLogins, getPat, getLoginForSlack } from "../lib/store.js";
import {
  clientForToken,
  getPullRequest,
  tryGetPullRequest,
  approve,
  type GitHubClient,
} from "../lib/github.js";

interface ProcessInput {
  ref: PrRef | null;
  slackUserIds: string[];
  cfg: Config;
  // Absolute base URL of this deployment, so /setup links are clickable.
  appBaseUrl: string;
  // --dangerously-skip-permissions: bypass the protected-branch safeguard.
  skipProtected?: boolean;
}

// A PR reference is either fully specified (owner/repo/number) or just a number
// that must be matched against the configured repos. Returns the resolved
// target plus its metadata, or a user-facing message explaining why it can't.
async function resolveTarget(
  ref: PrRef,
  readClient: GitHubClient,
  cfg: Config,
  setup: string,
): Promise<
  | { owner: string; repo: string; number: number; author: string; baseRef: string }
  | { error: string }
> {
  if (ref.repo) {
    const { author, baseRef } = await getPullRequest(
      readClient,
      ref.owner,
      ref.repo,
      ref.number,
    );
    return { owner: ref.owner, repo: ref.repo, number: ref.number, author, baseRef };
  }

  // Bare number: probe each configured repo for an open PR with this number.
  const matches: { repo: string; author: string; baseRef: string }[] = [];
  for (const repo of cfg.repos) {
    const found = await tryGetPullRequest(readClient, ref.owner, repo, ref.number);
    if (found && found.state === "open") {
      matches.push({ repo, author: found.author, baseRef: found.baseRef });
    }
  }

  if (matches.length === 0) {
    return {
      error: `⚠️ Couldn't find an open PR #${ref.number} in any configured repo. It may not exist, or the reviewer's token lacks access — try \`<repo>/pull/${ref.number}\` or check ${setup}.`,
    };
  }
  if (matches.length > 1) {
    return {
      error: `⚠️ PR #${ref.number} is open in multiple repos: ${matches
        .map((m) => m.repo)
        .join(", ")}. Specify one, e.g. \`${matches[0].repo}/pull/${ref.number}\`.`,
    };
  }
  const m = matches[0];
  return {
    owner: ref.owner,
    repo: m.repo,
    number: ref.number,
    author: m.author,
    baseRef: m.baseRef,
  };
}

export async function processApproval(input: ProcessInput): Promise<string> {
  const { ref, slackUserIds, cfg, appBaseUrl, skipProtected } = input;
  const setup = appBaseUrl ? `${appBaseUrl}/setup` : "/setup";
  if (!ref) {
    return `⚠️ I couldn't find a PR. Mention me with a PR and reviewers, e.g. \`@approver 1164 @bob\` (or a full URL / \`repo/pull/N\`).`;
  }

  const resolved: string[] = [];
  const notLinked: string[] = [];
  for (const id of slackUserIds) {
    const login = await getLoginForSlack(id);
    if (login) resolved.push(login);
    else notLinked.push(id);
  }

  // Read the PR using one of the tagged reviewers' own PATs — there is no bot
  // token. Use the first resolved reviewer who has a stored PAT.
  let readClient: GitHubClient | null = null;
  let readLogin = "";
  for (const login of resolved) {
    const pat = await getPat(login, cfg.encryptionKey);
    if (pat) {
      readClient = clientForToken(pat);
      readLogin = login;
      break;
    }
  }
  if (!readClient) {
    const lines = [
      "⚠️ None of the tagged reviewers have a registered token, so I can't read the PR.",
    ];
    if (notLinked.length) {
      lines.push(
        `Not linked: ${notLinked.map((id) => `<@${id}>`).join(", ")}`,
      );
    }
    lines.push(`Register a classic PAT (with the \`repo\` scope) at ${setup}.`);
    return lines.join("\n");
  }

  let target: Awaited<ReturnType<typeof resolveTarget>>;
  try {
    target = await resolveTarget(ref, readClient, cfg, setup);
  } catch {
    return `❌ Couldn't read the PR with @${readLogin}'s token — it likely lacks access to the repo. Re-register a classic token with the \`repo\` scope at ${setup}.`;
  }
  if ("error" in target) return target.error;
  const { owner, repo, number, author, baseRef } = target;

  const registeredLogins = await listLogins();
  const result = decide({
    mentions: resolved,
    author,
    baseRef,
    protectedBranches: cfg.protectedBranches,
    registeredLogins,
    skipProtected,
  });

  if (result.blocked) {
    return `🚫 I won't auto-approve PRs targeting \`${result.blockedBranch}\` (protected branch).`;
  }

  const approved: string[] = [];
  const failed: string[] = [];
  for (const login of result.approveAs) {
    try {
      const pat = await getPat(login, cfg.encryptionKey);
      if (!pat) {
        failed.push(`@${login} — token missing`);
        continue;
      }
      await approve(clientForToken(pat), owner, repo, number);
      approved.push(`@${login}`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown error";
      failed.push(`@${login} — ${reason}`);
    }
  }

  const prLink = `<https://github.com/${owner}/${repo}/pull/${number}|#${number}>`;
  const lines: string[] = [];
  if (approved.length) {
    lines.push(`✅ Approved ${prLink} as ${approved.join(", ")}`);
  }
  if (result.skippedNoPat.length) {
    lines.push(
      `⚠️ Skipped ${result.skippedNoPat
        .map((l) => `@${l}`)
        .join(", ")} — no PAT registered (visit ${setup})`,
    );
  }
  if (notLinked.length) {
    lines.push(
      `⚠️ Not linked: ${notLinked
        .map((id) => `<@${id}>`)
        .join(", ")} — link your Slack ID at ${setup}`,
    );
  }
  if (failed.length) lines.push(`❌ ${failed.join("; ")}`);
  if (!lines.length) {
    lines.push("Nobody to approve as — tag a registered, linked reviewer.");
  }
  return lines.join("\n");
}

// Several PRs are in scope and the mention named none — list them rather than
// risk approving the wrong one.
function ambiguousPrMessage(candidates: PrRef[]): string {
  const list = candidates
    .map((c) => `\`${c.owner}/${c.repo}/pull/${c.number}\``)
    .join(", ");
  return (
    `⚠️ I found multiple recent PRs and won't guess which to approve: ${list}. ` +
    `Reply in the PR's thread, or mention me with the PR (number or URL).`
  );
}

// Post a reply in the channel, threaded under the triggering message.
async function postSlackMessage(
  botToken: string,
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) console.error("chat.postMessage failed:", data.error);
}

// Absolute base URL of this deployment, derived from the proxy headers Vercel
// sets — used to build clickable /setup links in replies.
function baseUrl(req: Request): string {
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "";
}

interface SlackEventBody {
  type?: string;
  challenge?: string;
  api_app_id?: string;
  authorizations?: { user_id?: string }[];
  event?: {
    type?: string;
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
    user?: string;
  };
}

export async function handler(req: Request): Promise<Response> {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error("slack config error:", err);
    return new Response("configuration error", { status: 500 });
  }

  const raw = await req.text();
  const ok = verifySlackSignature(
    raw,
    req.headers.get("x-slack-request-timestamp"),
    req.headers.get("x-slack-signature"),
    cfg.slackSigningSecret,
  );
  if (!ok) return new Response("invalid signature", { status: 401 });

  let body: SlackEventBody;
  try {
    body = JSON.parse(raw) as SlackEventBody;
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // Slack's one-time endpoint verification handshake.
  if (body.type === "url_verification") {
    return new Response(body.challenge ?? "", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  // Slack retries on any non-2xx or slow ack. We always ack fast, but if a retry
  // does arrive, skip reprocessing so we don't approve / reply twice.
  if (req.headers.get("x-slack-retry-num")) {
    return new Response("ok", { status: 200 });
  }

  const event = body.event;
  // Only act on app_mention events from humans (ignore the bot's own posts).
  if (event?.type === "app_mention" && !event.bot_id) {
    const text = event.text ?? "";
    const botUserId = body.authorizations?.[0]?.user_id;
    let ref = parsePrRef(text, cfg.defaultOwner);
    // Drop the bot's own mention so it isn't treated as a reviewer.
    const tagged = parseSlackUserIds(text).filter((id) => id !== botUserId);
    // No reviewers tagged? Approve as whoever mentioned the bot.
    const slackUserIds = tagged.length ? tagged : event.user ? [event.user] : [];
    const skipProtected = parseSkipPermissions(text);
    const channel = event.channel ?? "";
    const threadTs = event.thread_ts ?? event.ts ?? "";
    const appBaseUrl = baseUrl(req);

    // We await waitUntil's return: void (no-op) in prod, the promise under test.
    await waitUntil(
      (async () => {
        try {
          // No PR in the mention? Find it from context — but first learn the
          // bot's own identity (bot_id via auth.test, plus the user/app id from
          // the event) so its own posts are excluded from every scan.
          let summary: string;
          if (!ref && channel) {
            const self = await fetchBotIdentity(cfg.slackBotToken);
            if (botUserId && !self.userId) self.userId = botUserId;
            self.appId = body.api_app_id;

            // First the thread it was posted in (replies need a real thread_ts —
            // event.ts is the mention itself, not a thread); its root is usually
            // the PR notification.
            if (event.thread_ts) {
              ref = await resolvePrFromThread(
                cfg.slackBotToken,
                channel,
                event.thread_ts,
                cfg.defaultOwner,
                self,
              );
            }
            // Still nothing — a top-level mention (no thread) or a thread not
            // rooted at a PR notification. Look in the channel's recent history,
            // but only act on a single unambiguous PR: with several we refuse to
            // guess (approving the wrong PR is worse than asking).
            if (!ref) {
              const resolution = await resolvePrFromChannel(
                cfg.slackBotToken,
                channel,
                cfg.defaultOwner,
                self,
                event.ts,
              );
              if (resolution.kind === "found") ref = resolution.ref;
              else if (resolution.kind === "ambiguous") {
                summary = ambiguousPrMessage(resolution.candidates);
              }
            }
          }
          summary ??= await processApproval({ ref, slackUserIds, cfg, appBaseUrl, skipProtected });
          if (channel) await postSlackMessage(cfg.slackBotToken, channel, threadTs, summary);
        } catch (err) {
          console.error("slack approval failed:", err);
          if (channel) {
            await postSlackMessage(
              cfg.slackBotToken,
              channel,
              threadTs,
              "❌ Something went wrong processing the approval.",
            );
          }
        }
      })(),
    );
  }

  // Ack within Slack's 3s window.
  return new Response("ok", { status: 200 });
}

// Vercel reads a default export with a `fetch` method as a Web Handler
// (Request -> Response). A bare default function would be treated as the
// legacy (req, res) Node signature and its returned Response ignored.
export default { fetch: handler };
