/**
 * PostgreSQL access: `pg` Pool singleton + transaction helper.
 *
 * - Pool is created lazily from `env.databaseUrl` (never at import time, so
 *   `next build` and unit tests that don't touch the DB keep working).
 * - `withTx()` runs the callback inside ONE transaction (BEGIN/COMMIT or
 *   ROLLBACK) and always releases the client.
 * - Retry-on-boot: the first connection attempt retries with backoff so
 *   `docker compose up` ordering (app starting before Postgres is ready)
 *   doesn't crash the app. Only connection-refused/timeout style errors are
 *   retried; auth errors fail fast.
 */
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { env } from "./env";

let pool: Pool | null = null;
let bootProbe: Promise<void> | null = null;

const BOOT_RETRIES = 12;
const BOOT_BASE_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBootError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    code === "EHOSTUNREACH"
  );
}

/** Wait until Postgres accepts a connection, with backoff. Throws the last error. */
async function waitForBoot(p: Pool): Promise<void> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= BOOT_RETRIES; attempt++) {
    try {
      const client = await p.connect();
      try {
        await client.query("SELECT 1");
      } finally {
        client.release();
      }
      return;
    } catch (err) {
      lastErr = err;
      if (!isBootError(err)) throw err; // fail fast on auth/config errors
      const delay = Math.min(BOOT_BASE_DELAY_MS * 2 ** (attempt - 1), 15000);
      // eslint-disable-next-line no-console
      console.log(
        `[db] postgres not ready (attempt ${attempt}/${BOOT_RETRIES}, ${codeOf(err)}); retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

function codeOf(err: unknown): string {
  return (err as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
}

/** Lazily-created process-wide pool. */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env.databaseUrl, // throws only when first used
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[db] idle pool client error", err);
    });
    bootProbe = waitForBoot(pool).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[db] postgres never became ready; queries will fail", err);
      throw err;
    });
  }
  return pool;
}

/** One-off query outside a transaction. Waits for boot first. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  const p = getPool();
  if (bootProbe) await bootProbe;
  return p.query<T>(text, params as unknown[]);
}

export type TxClient = PoolClient;

/**
 * Run `fn` inside a single transaction. Commits on success, rolls back on
 * error, and always releases the client back to the pool.
 */
export async function withTx<T>(fn: (tx: TxClient) => Promise<T>): Promise<T> {
  const p = getPool();
  if (bootProbe) await bootProbe;
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* rollback best-effort */
    }
    throw err;
  } finally {
    client.release();
  }
}
