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
  // Identity of the author, used to exclude the bot's own messages — otherwise
  // its "@approver 1164" hint or its "Approved …/pull/N" reply would be read
  // back as a PR reference. A human's post has `user`; a bot's post always has
  // `bot_id` (and may carry `app_id`) but often omits `user` (the bot_message
  // subtype). We match on whichever is present. Other apps (GitHub) have a
  // different bot_id/app_id and are still scanned.
  user?: string;
  bot_id?: string;
  app_id?: string;
}

// How to recognise the bot's own messages. Populated from auth.test (bot_id is
// the only field Slack guarantees on every bot post) plus the event's
// authorizations (user id) and api_app_id.
export interface BotIdentity {
  userId?: string;
  botId?: string;
  appId?: string;
}

function isOwnMessage(msg: SlackMessage, self?: BotIdentity): boolean {
  if (!self) return false;
  return (
    (!!self.userId && msg.user === self.userId) ||
    (!!self.botId && msg.bot_id === self.botId) ||
    (!!self.appId && msg.app_id === self.appId)
  );
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

// Scan messages in array order for the first parseable PR reference, skipping
// the bot's own messages (so its usage hint can't be read back as a PR). Callers
// pass messages in the order that encodes their preference: replies oldest-first
// (the thread root — GitHub's PR notification — is index 0), history newest-first
// (the most recent PR notification wins).
export function extractPrRef(
  messages: SlackMessage[],
  defaultOwner: string,
  self?: BotIdentity,
): PrRef | null {
  for (const msg of messages) {
    if (isOwnMessage(msg, self)) continue;
    const ref = parsePrRef(messageSearchText(msg), defaultOwner);
    if (ref) return ref;
  }
  return null;
}

// Fetch messages from a Slack `conversations.*` read method, returning [] on any
// error so callers fall back to the normal "no PR found" path.
async function fetchMessages(
  botToken: string,
  endpoint: string,
  params: Record<string, string>,
): Promise<SlackMessage[]> {
  const qs = new URLSearchParams(params).toString();
  const url = `https://slack.com/api/${endpoint}?${qs}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${botToken}` },
  });
  const data = (await res.json()) as {
    ok: boolean;
    messages?: SlackMessage[];
    error?: string;
  };
  if (!data.ok) {
    console.error(`${endpoint} failed:`, data.error);
    return [];
  }
  return data.messages ?? [];
}

// Fetch a thread's messages (oldest first; index 0 is the thread root).
export function fetchThreadReplies(
  botToken: string,
  channel: string,
  threadTs: string,
): Promise<SlackMessage[]> {
  return fetchMessages(botToken, "conversations.replies", {
    channel,
    ts: threadTs,
  });
}

// Fetch recent channel messages (newest first). Used to locate the most recent
// GitHub PR notification when the bot is mentioned outside the PR's thread.
// `latest` bounds the window to messages at/before the mention, so a PR opened
// *after* the user spoke can't win.
export function fetchChannelHistory(
  botToken: string,
  channel: string,
  latest?: string,
  limit = 50,
): Promise<SlackMessage[]> {
  const params: Record<string, string> = { channel, limit: String(limit) };
  if (latest) params.latest = latest;
  return fetchMessages(botToken, "conversations.history", params);
}

// Resolve a PR reference from the thread the bot was mentioned in. The thread
// root (index 0) is preferred — that's where the GitHub PR notification sits.
export async function resolvePrFromThread(
  botToken: string,
  channel: string,
  threadTs: string,
  defaultOwner: string,
  self?: BotIdentity,
): Promise<PrRef | null> {
  const messages = await fetchThreadReplies(botToken, channel, threadTs);
  return extractPrRef(messages, defaultOwner, self);
}

// Collect the distinct, fully-qualified PR references in a set of messages
// (owner/repo/number — i.e. real GitHub PR notifications/links), skipping the
// bot's own messages. Bare numbers typed in chat are deliberately ignored: they
// are too weak a signal to approve on. Order and dedup follow the input.
export function collectPrRefs(
  messages: SlackMessage[],
  defaultOwner: string,
  self?: BotIdentity,
): PrRef[] {
  const out: PrRef[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    if (isOwnMessage(msg, self)) continue;
    const ref = parsePrRef(messageSearchText(msg), defaultOwner);
    if (!ref || ref.repo === null) continue;
    const key = `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

// The outcome of looking for a PR in channel history when the mention named none.
// `found` only when exactly one PR is in scope — never a guess between several.
export type ChannelPrResolution =
  | { kind: "found"; ref: PrRef }
  | { kind: "ambiguous"; candidates: PrRef[] }
  | { kind: "none" };

// Resolve a PR from recent channel history at/before `latest` (the mention's ts,
// so a PR opened after the user spoke can't win). Lets a fresh top-level
// @mention — not threaded under the PR — find the PR it's about, but only when
// there is exactly one; with several it refuses to guess and reports them all.
export async function resolvePrFromChannel(
  botToken: string,
  channel: string,
  defaultOwner: string,
  self?: BotIdentity,
  latest?: string,
): Promise<ChannelPrResolution> {
  const messages = await fetchChannelHistory(botToken, channel, latest);
  const refs = collectPrRefs(messages, defaultOwner, self);
  if (refs.length === 0) return { kind: "none" };
  if (refs.length === 1) return { kind: "found", ref: refs[0] };
  return { kind: "ambiguous", candidates: refs };
}

// Look up the bot's own identity so its posts can be excluded from scans. bot_id
// is the identifier Slack stamps on every bot message (the `user` field is often
// absent). Returns {} on any error — resolution then falls back to the user id /
// app id the caller already has from the event.
export async function fetchBotIdentity(botToken: string): Promise<BotIdentity> {
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: { authorization: `Bearer ${botToken}` },
    });
    const data = (await res.json()) as {
      ok: boolean;
      user_id?: string;
      bot_id?: string;
    };
    if (!data.ok) return {};
    return { userId: data.user_id, botId: data.bot_id };
  } catch {
    return {};
  }
}
