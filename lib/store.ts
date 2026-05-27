import { neon } from "@neondatabase/serverless";
import { encrypt, decrypt } from "./crypto";

const norm = (login: string) => login.toLowerCase();

// The `@neondatabase/serverless` v0.10 NeonQueryFunction type does not expose
// a `.query` method on its interface (it is a callable tagged-template fn), but
// the HTTP driver's runtime object does accept `sql.query(text, params)` as an
// ordinary call.  We define our own minimal interface so TypeScript is satisfied
// without casting away all type safety.
interface DbClient {
  query(text: string, params?: unknown[]): Promise<unknown[]>;
}

// Lazily create one HTTP client per cold start.
let _sql: DbClient | null = null;
function db(): DbClient {
  if (!_sql) {
    _sql = neon(process.env.DATABASE_URL!) as unknown as DbClient;
  }
  return _sql;
}

export async function putPat(
  login: string,
  pat: string,
  key: Buffer,
): Promise<void> {
  await db().query(
    `INSERT INTO pats (login, ciphertext) VALUES ($1, $2)
     ON CONFLICT (login) DO UPDATE SET ciphertext = EXCLUDED.ciphertext`,
    [norm(login), encrypt(pat, key)],
  );
}

export async function getPat(
  login: string,
  key: Buffer,
): Promise<string | null> {
  const rows = (await db().query(
    `SELECT ciphertext FROM pats WHERE login = $1`,
    [norm(login)],
  )) as { ciphertext: string }[];
  return rows[0] ? decrypt(rows[0].ciphertext, key) : null;
}

export async function delPat(login: string): Promise<void> {
  await db().query(`DELETE FROM pats WHERE login = $1`, [norm(login)]);
}

export async function listLogins(): Promise<string[]> {
  const rows = (await db().query(`SELECT login FROM pats`)) as {
    login: string;
  }[];
  return rows.map((r) => r.login);
}
