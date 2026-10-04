import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
export async function migrate(connectionString: string, tls: boolean) {
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 60000,
    ssl: tls ? { rejectUnauthorized: true } : false,
  });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(719845621)');
    await client.query(
      `CREATE TABLE IF NOT EXISTS public.matrimony_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const dir = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(dir)).filter((v) => /^\d+.*\.sql$/.test(v)).sort()) {
      const sql = await readFile(new URL(name, dir), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query(
        'SELECT checksum FROM public.matrimony_migrations WHERE name=$1',
        [name],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Migration changed: ${name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO public.matrimony_migrations(name,checksum) VALUES ($1,$2)',
          [name, checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    client.release(true);
    await pool.end();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is required');
  await migrate(url, process.env.DB_SSL !== 'disable');
  console.log('Migrations applied');
}
