import { waitUntil } from "@vercel/functions";
import { loadConfig, type Config } from "../lib/config.js";
import {
  verifySlackSignature,
  parsePrRef,
  parseSlackUserIds,
  type PrRef,
} from "../lib/slack.js";
import { decide } from "../lib/decide.js";
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
}

// A PR reference is either fully specified (owner/repo/number) or just a number
// that must be matched against the configured repos. Returns the resolved
// target plus its metadata, or a user-facing message explaining why it can't.
async function resolveTarget(
  ref: PrRef,
  readClient: GitHubClient,
  cfg: Config,
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
      error: `⚠️ Couldn't find an open PR #${ref.number} in any configured repo. Try \`<repo>/pull/${ref.number}\`.`,
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
  const { ref, slackUserIds, cfg } = input;
  if (!ref) {
    return "⚠️ Couldn't find a PR in your command. Usage: `/approve-as <pr-url | repo/pull/N | N> @user`";
  }

  const resolved: string[] = [];
  const notLinked: string[] = [];
  for (const id of slackUserIds) {
    const login = await getLoginForSlack(id);
    if (login) resolved.push(login);
    else notLinked.push(id);
  }

  const botClient = clientForToken(cfg.botPat);
  const target = await resolveTarget(ref, botClient, cfg);
  if ("error" in target) return target.error;
  const { owner, repo, number, author, baseRef } = target;

  const registeredLogins = await listLogins();
  const result = decide({
    mentions: resolved,
    author,
    baseRef,
    protectedBranches: cfg.protectedBranches,
    registeredLogins,
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

  const lines: string[] = [];
  if (approved.length) lines.push(`✅ Approved as ${approved.join(", ")}`);
  if (result.skippedNoPat.length) {
    lines.push(
      `⚠️ Skipped ${result.skippedNoPat
        .map((l) => `@${l}`)
        .join(", ")} — no PAT registered (visit /setup)`,
    );
  }
  if (notLinked.length) {
    lines.push(
      `⚠️ Not linked: ${notLinked
        .map((id) => `<@${id}>`)
        .join(", ")} — link your Slack ID at /setup`,
    );
  }
  if (failed.length) lines.push(`❌ ${failed.join("; ")}`);
  if (!lines.length) {
    lines.push("Nobody to approve as — tag a registered, linked reviewer.");
  }
  return lines.join("\n");
}

async function postToSlack(responseUrl: string, text: string): Promise<void> {
  await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response_type: "in_channel", text }),
  });
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

  const form = new URLSearchParams(raw);
  const text = form.get("text") ?? "";
  const responseUrl = form.get("response_url");

  const ref = parsePrRef(text, cfg.defaultOwner);
  const slackUserIds = parseSlackUserIds(text);

  // Finish the GitHub work after acking; post the result to Slack.
  // We await the return value of waitUntil: in production it returns void
  // (no-op), but the test mock returns the promise so tests can observe effects.
  await waitUntil(
    (async () => {
      try {
        const summary = await processApproval({ ref, slackUserIds, cfg });
        if (responseUrl) await postToSlack(responseUrl, summary);
      } catch (err) {
        console.error("slack approval failed:", err);
        if (responseUrl) {
          await postToSlack(responseUrl, "❌ Something went wrong processing the approval.");
        }
      }
    })(),
  );

  // Ack within Slack's 3s window. in_channel so Slack echoes the user's
  // command into the channel publicly and the ack/summary are visible to all.
  return new Response(
    JSON.stringify({ response_type: "in_channel", text: "⏳ Working on it…" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// Vercel reads a default export with a `fetch` method as a Web Handler
// (Request -> Response). A bare default function would be treated as the
// legacy (req, res) Node signature and its returned Response ignored.
export default { fetch: handler };
