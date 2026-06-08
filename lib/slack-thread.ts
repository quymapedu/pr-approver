import { parsePrRef, type PrRef } from "./slack.js";

export interface SlackAttachment {
  title?: string;
  title_link?: string;
  fallback?: string;
  text?: string;
}

export interface SlackMessage {
  text?: string;
  attachments?: SlackAttachment[];
  blocks?: unknown;
}

// Build one searchable string for a message: the visible text plus the places
// the GitHub Slack app hides the PR URL (attachment title_link/title/fallback/
// text), plus a stringified blocks fallback for any other layout.
export function messageSearchText(msg: SlackMessage): string {
  const parts: string[] = [];
  if (msg.text) parts.push(msg.text);
  for (const a of msg.attachments ?? []) {
    if (a.title_link) parts.push(a.title_link);
    if (a.title) parts.push(a.title);
    if (a.fallback) parts.push(a.fallback);
    if (a.text) parts.push(a.text);
  }
  if (msg.blocks) parts.push(JSON.stringify(msg.blocks));
  return parts.join(" ");
}

// Scan messages root-first (conversations.replies returns oldest first, so the
// thread root — GitHub's PR notification — is index 0) for the first parseable
// PR reference.
export function extractPrRef(
  messages: SlackMessage[],
  defaultOwner: string,
): PrRef | null {
  for (const msg of messages) {
    const ref = parsePrRef(messageSearchText(msg), defaultOwner);
    if (ref) return ref;
  }
  return null;
}

// Fetch a thread's messages (oldest first; index 0 is the thread root). Returns
// [] on any Slack error so callers fall back to the normal "no PR found" path.
export async function fetchThreadReplies(
  botToken: string,
  channel: string,
  threadTs: string,
): Promise<SlackMessage[]> {
  const url =
    "https://slack.com/api/conversations.replies" +
    `?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${botToken}` },
  });
  const data = (await res.json()) as {
    ok: boolean;
    messages?: SlackMessage[];
    error?: string;
  };
  if (!data.ok) {
    console.error("conversations.replies failed:", data.error);
    return [];
  }
  return data.messages ?? [];
}

// Resolve a PR reference from the thread the bot was mentioned in.
export async function resolvePrFromThread(
  botToken: string,
  channel: string,
  threadTs: string,
  defaultOwner: string,
): Promise<PrRef | null> {
  const messages = await fetchThreadReplies(botToken, channel, threadTs);
  return extractPrRef(messages, defaultOwner);
}
