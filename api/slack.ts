import { waitUntil } from "@vercel/functions";
import { loadConfig, type Config } from "../lib/config";
import { verifySlackSignature, parsePrUrl, parseSlackUserIds } from "../lib/slack";
import { decide } from "../lib/decide";
import { listLogins, getPat, getLoginForSlack } from "../lib/store";
import { clientForToken, getPullRequest, approve } from "../lib/github";

interface ProcessInput {
  pr: { owner: string; repo: string; number: number } | null;
  slackUserIds: string[];
  cfg: Config;
}

export async function processApproval(input: ProcessInput): Promise<string> {
  const { pr, slackUserIds, cfg } = input;
  if (!pr) {
    return "⚠️ Couldn't find a GitHub PR URL in your command. Usage: `/approve-as <pr-url> @user`";
  }

  const resolved: string[] = [];
  const notLinked: string[] = [];
  for (const id of slackUserIds) {
    const login = await getLoginForSlack(id);
    if (login) resolved.push(login);
    else notLinked.push(id);
  }

  const botClient = clientForToken(cfg.botPat);
  const { author, baseRef } = await getPullRequest(
    botClient,
    pr.owner,
    pr.repo,
    pr.number,
  );

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
      await approve(clientForToken(pat), pr.owner, pr.repo, pr.number);
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

export default async function handler(req: Request): Promise<Response> {
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

  const pr = parsePrUrl(text);
  const slackUserIds = parseSlackUserIds(text);

  // Finish the GitHub work after acking; post the result to Slack.
  // We await the return value of waitUntil: in production it returns void
  // (no-op), but the test mock returns the promise so tests can observe effects.
  await waitUntil(
    (async () => {
      try {
        const summary = await processApproval({ pr, slackUserIds, cfg });
        if (responseUrl) await postToSlack(responseUrl, summary);
      } catch (err) {
        console.error("slack approval failed:", err);
        if (responseUrl) {
          await postToSlack(responseUrl, "❌ Something went wrong processing the approval.");
        }
      }
    })(),
  );

  // Ack within Slack's 3s window.
  return new Response(
    JSON.stringify({ response_type: "ephemeral", text: "⏳ Working on it…" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
