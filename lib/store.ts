import { neon } from "@neondatabase/serverless";
import { encrypt, decrypt } from "./crypto";

const norm = (login: string) => login.toLowerCase();

// Lazily create one HTTP query function per cold start.
let _sql: ReturnType<typeof neon> | null = null;
function db() {
  return (_sql ??= neon(process.env.DATABASE_URL!));
}

export async function putPat(
  login: string,
  pat: string,
  key: Buffer,
): Promise<void> {
  await db()(
    `INSERT INTO pats (login, ciphertext) VALUES ($1, $2)
     ON CONFLICT (login) DO UPDATE SET ciphertext = EXCLUDED.ciphertext`,
    [norm(login), encrypt(pat, key)],
  );
}

export async function getPat(
  login: string,
  key: Buffer,
): Promise<string | null> {
  const rows = (await db()(`SELECT ciphertext FROM pats WHERE login = $1`, [
    norm(login),
  ])) as { ciphertext: string }[];
  return rows[0] ? decrypt(rows[0].ciphertext, key) : null;
}

export async function delPat(login: string): Promise<void> {
  await db()(`DELETE FROM pats WHERE login = $1`, [norm(login)]);
}

export async function listLogins(): Promise<string[]> {
  const rows = (await db()(`SELECT login FROM pats`)) as { login: string }[];
  return rows.map((r) => r.login);
}
