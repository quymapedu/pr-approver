// GitHub logins: 1-39 chars, alphanumeric or single hyphens.
const MENTION_RE = /@([a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38})/gi;

function stripCode(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, " ") // fenced blocks
    .replace(/`[^`]*`/g, " "); // inline code
}

export function extractMentions(body: string): string[] {
  const text = stripCode(body);
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const login = m[1].toLowerCase();
    if (!out.includes(login)) out.push(login);
  }
  return out;
}

export function containsTrigger(body: string, trigger: string): boolean {
  return extractMentions(body).includes(trigger.toLowerCase());
}
