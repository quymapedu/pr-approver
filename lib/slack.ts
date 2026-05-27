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

export function parsePrUrl(
  text: string,
): { owner: string; repo: string; number: number } | null {
  const m = text.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

export function parseSlackUserIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}
