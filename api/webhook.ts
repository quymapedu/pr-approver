import { loadConfig } from "../lib/config";
import { verifySignature } from "../lib/verify";
import { extractMentions, containsTrigger } from "../lib/parse";
import { decide } from "../lib/decide";
import { listLogins, getPat } from "../lib/store";
import {
  makeApp,
  getInstallationClient,
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
  installation?: { id: number };
}

export default async function handler(req: Request): Promise<Response> {
  const cfg = loadConfig();
  const raw = await req.text();

  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), cfg.webhookSecret)) {
    return new Response("invalid signature", { status: 401 });
  }

  const evt = JSON.parse(raw) as IssueCommentEvent;

  // Only top-level comments created on a PR.
  if (evt.action !== "created" || !evt.issue?.pull_request) {
    return new Response("ignored", { status: 200 });
  }
  if (!containsTrigger(evt.comment.body, cfg.triggerMention)) {
    return new Response("no trigger", { status: 200 });
  }
  if (!evt.installation) {
    return new Response("no installation", { status: 200 });
  }

  const owner = evt.repository.owner.login;
  const repo = evt.repository.name;
  const prNumber = evt.issue.number;

  const app = makeApp(cfg);
  const appClient = await getInstallationClient(app, evt.installation.id);
  const { author, baseRef } = await getPullRequest(appClient, owner, repo, prNumber);

  const registeredLogins = await listLogins();
  const result = decide({
    mentions: extractMentions(evt.comment.body),
    botMention: cfg.triggerMention,
    author,
    baseRef,
    protectedBranches: cfg.protectedBranches,
    registeredLogins,
  });

  if (result.blocked) {
    await postComment(
      appClient,
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

  await postComment(appClient, owner, repo, prNumber, lines.join("\n"));
  return new Response("ok", { status: 200 });
}
