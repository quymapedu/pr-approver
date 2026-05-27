import { loadConfig } from "../lib/config";
import { putPat, delPat } from "../lib/store";
import { clientForToken, getAuthenticatedLogin } from "../lib/github";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const cfg = loadConfig();
  let payload: { action?: string; accessCode?: string; pat?: string };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const { action = "register", accessCode, pat } = payload;
  if (accessCode !== cfg.setupAccessCode) {
    return json(403, { error: "Invalid access code" });
  }
  if (!pat) return json(400, { error: "Missing pat" });

  let login: string;
  try {
    login = await getAuthenticatedLogin(clientForToken(pat));
  } catch {
    return json(401, { error: "Token rejected by GitHub" });
  }

  if (action === "remove") {
    await delPat(login);
    return json(200, { login, removed: true });
  }

  await putPat(login, pat, cfg.encryptionKey);
  return json(200, { login, registered: true });
}
