import { loadConfig, type Config } from "../lib/config";
import { verifySignature } from "../lib/verify";
import { extractMentions, containsKeyword } from "../lib/parse";
import { decide } from "../lib/decide";
import { listLogins, getPat } from "../lib/store";
import {
  clientForToken,
  getPullRequest,
  approve,
  postComment,
} from "../lib/github";

interface IssueCommentEvent {
  action: string;
  issue: { number: number; pull_request?: unknown; user: { login: string } };
  comment: { body: string };
  repository: { owner: { login: string }; name: string };
}

export default async function handler(req: Request): Promise<Response> {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error("webhook config error:", err);
    return new Response("configuration error", { status: 500 });
  }

  const raw = await req.text();

  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), cfg.webhookSecret)) {
    return new Response("invalid signature", { status: 401 });
  }

  const evt = JSON.parse(raw) as IssueCommentEvent;

  // Only top-level comments created on a PR.
  if (evt.action !== "created" || !evt.issue?.pull_request) {
    return new Response("ignored", { status: 200 });
  }
  if (!containsKeyword(evt.comment.body, cfg.triggerKeyword)) {
    return new Response("no trigger", { status: 200 });
  }

  const owner = evt.repository.owner.login;
  const repo = evt.repository.name;
  const prNumber = evt.issue.number;

  try {
    const botClient = clientForToken(cfg.botPat);
    const { author, baseRef } = await getPullRequest(botClient, owner, repo, prNumber);

    const registeredLogins = await listLogins();
    const result = decide({
      mentions: extractMentions(evt.comment.body),
      author,
      baseRef,
      protectedBranches: cfg.protectedBranches,
      registeredLogins,
    });

    if (result.blocked) {
      await postComment(
        botClient,
        owner,
        repo,
        prNumber,
        `🚫 I won't auto-approve PRs targeting \`${result.blockedBranch}\` (protected branch).`,
      );
      return new Response("blocked", { status: 200 });
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
        await approve(clientForToken(pat), owner, repo, prNumber);
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
    if (failed.length) lines.push(`❌ ${failed.join("; ")}`);
    if (!lines.length) lines.push("Nobody to approve as — tag a registered reviewer.");

    await postComment(botClient, owner, repo, prNumber, lines.join("\n"));
    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("webhook orchestration failed:", err);
    return new Response("internal error", { status: 500 });
  }
}
