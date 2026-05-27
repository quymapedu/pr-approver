import { timingSafeEqual } from "node:crypto";
import { loadConfig, type Config } from "../lib/config.js";
import { putPat, delPat, putSlackLink, delSlackLink } from "../lib/store.js";
import { clientForToken, getAuthenticatedLogin } from "../lib/github.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function codeMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error("register config error:", err);
    return json(500, { error: "Configuration error" });
  }

  let payload: {
    action?: string;
    accessCode?: string;
    pat?: string;
    slackUserId?: string;
  };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const { action = "register", accessCode, pat, slackUserId } = payload;
  if (!codeMatches(accessCode, cfg.setupAccessCode)) {
    return json(403, { error: "Invalid access code" });
  }
  if (!pat) return json(400, { error: "Missing pat" });
  // Classic tokens only: fine-grained tokens (github_pat_…) are blocked by org
  // policy in our setup and fail at approval time, so reject them up front.
  if (pat.startsWith("github_pat_")) {
    return json(400, {
      error:
        "Fine-grained tokens are not supported. Create a classic token with the 'repo' scope.",
    });
  }

  let login: string;
  try {
    login = await getAuthenticatedLogin(clientForToken(pat));
  } catch {
    return json(401, { error: "Token rejected by GitHub" });
  }

  try {
    if (action === "remove") {
      await delPat(login);
      if (slackUserId) await delSlackLink(slackUserId);
      return json(200, { login, removed: true });
    }
    await putPat(login, pat, cfg.encryptionKey);
    if (slackUserId) await putSlackLink(slackUserId, login);
    return json(200, { login, registered: true });
  } catch (err) {
    console.error("register store failure:", err);
    return json(500, { error: "Storage error" });
  }
}

// Vercel reads a default export with a `fetch` method as a Web Handler
// (Request -> Response). A bare default function would be treated as the
// legacy (req, res) Node signature and its returned Response ignored.
export default { fetch: handler };
