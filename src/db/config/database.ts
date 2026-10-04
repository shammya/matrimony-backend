import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import type { AppConfig } from '../../config/env.js';
import type { Logger } from 'pino';
export type Transaction = Pick<PoolClient, 'query'>;
export class Database {
  constructor(private readonly pool: Pool) {}
  async ready() {
    const result = await this.pool.query<{ unsafe: boolean }>(
      `SELECT rolsuper OR rolbypassrls AS unsafe FROM pg_roles WHERE rolname = current_user`,
    );
    if (result.rows[0]?.unsafe !== false)
      throw new Error('Runtime database role must not bypass RLS');
    await this.pool.query('SELECT 1 FROM matrimony.event_outbox LIMIT 0');
  }
  async transaction<T>(agencyId: string, operation: (tx: Transaction) => Promise<T>): Promise<T> {
    z.uuid().parse(agencyId);
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.agency_id', $1, true)", [agencyId]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = new Error('Rollback failed; discard pooled connection');
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }
  async ping() {
    await this.pool.query('SELECT 1');
  }
  async close() {
    await this.pool.end();
  }
}
export function createDatabase(config: AppConfig, logger: Logger): Database {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    connectionTimeoutMillis: config.DB_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: 30000,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    lock_timeout: config.DB_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: 15000,
    ssl: config.DB_SSL === 'verify-full' ? { rejectUnauthorized: true } : false,
    application_name: 'matrimony-backend',
  });
  pool.on('error', () =>
    logger.error({ code: 'DB_IDLE_CONNECTION_FAILED' }, 'Idle database connection failed'),
  );
  return new Database(pool);
}
