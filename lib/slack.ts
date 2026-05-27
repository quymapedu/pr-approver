import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  secret: string,
  nowMs: number = Date.now(),
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  // Replay protection: reject requests older than 5 minutes.
  if (Math.abs(nowMs / 1000 - ts) > 300) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected =
    "v0=" + createHmac("sha256", secret).update(base).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// A PR reference parsed from command text. `repo === null` means the user gave
// only a number, so the repo must be resolved by probing the configured repos.
export interface PrRef {
  owner: string;
  repo: string | null;
  number: number;
}

// Accepts, in priority order:
//   https://github.com/<owner>/<repo>/pull/<n>   (full or scheme-less URL)
//   <owner>/<repo>/pull/<n>  or  <repo>/pull/<n>
//   <owner>/<repo>#<n>       or  <repo>#<n>
//   <n>  or  #<n>            (bare number -> repo: null, owner: defaultOwner)
// Slack mention/link tokens (<@U…>, <#C…>, <http…>) are stripped first so their
// digits never get mistaken for a PR number.
export function parsePrRef(text: string, defaultOwner: string): PrRef | null {
  const cleaned = text.replace(/<[^>]*>/g, " ");

  const url = cleaned.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i);
  if (url) return { owner: url[1], repo: url[2], number: Number(url[3]) };

  const path = cleaned.match(/(?:([\w.-]+)\/)?([\w.-]+)\/pull\/(\d+)/i);
  if (path) {
    return { owner: path[1] ?? defaultOwner, repo: path[2], number: Number(path[3]) };
  }

  const hash = cleaned.match(/(?:([\w.-]+)\/)?([\w.-]+)#(\d+)/);
  if (hash) {
    return { owner: hash[1] ?? defaultOwner, repo: hash[2], number: Number(hash[3]) };
  }

  const bare = cleaned.match(/(?:^|\s)#?(\d+)(?:\s|$)/);
  if (bare) return { owner: defaultOwner, repo: null, number: Number(bare[1]) };

  return null;
}

export function parseSlackUserIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}
