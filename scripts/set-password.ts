import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { z } from 'zod';
import { emailSchema, newPasswordSchema } from '../src/bo/credentials.js';
import { PasswordHasher } from '../src/security/password-hasher.js';

// Operator tool: sets the password of an account, for example the first administrator, or a staff
// member who cannot use "forgot password" yet. It uses the migration (owner) connection, never the
// runtime one, and reads the password without echoing it, so it is not left in a shell history.
//
//   npm run auth:set-password -- --agency <uuid> --email <email>
//   npm run auth:set-password -- --agency <uuid> --account <uuid> --email <email>
//
// With --account, the email is written to the account when it has none (an account created before
// email sign-in existed). The account must be active to sign in; this tool does not change that.

const { values } = parseArgs({
  options: {
    agency: { type: 'string' },
    account: { type: 'string' },
    email: { type: 'string' },
  },
});
const agencyId = z.uuid().parse(values.agency);
const accountId = values.account ? z.uuid().parse(values.account) : undefined;
const email = emailSchema.parse(values.email);
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL is required');

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      // Piped input: the whole of stdin is the password.
      let data = '';
      input.setEncoding('utf8');
      input.on('data', (chunk) => (data += chunk));
      input.on('end', () => resolve(data.replace(/\r?\n$/, '')));
      input.on('error', reject);
      return;
    }
    process.stdout.write(prompt);
    let value = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const onData = (char: string) => {
      for (const c of char) {
        if (c === '\u0003') {
          input.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        } else if (c === '\r' || c === '\n') {
          input.setRawMode(false);
          input.pause();
          input.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        } else if (c === '\u007f' || c === '\b') {
          value = [...value].slice(0, -1).join('');
        } else {
          value += c;
        }
      }
    };
    input.on('data', onData);
  });
}

const password = newPasswordSchema.parse(await readHidden('New password (not shown): '));
const hash = await new PasswordHasher().hash(password);

const pool = new Pool({ connectionString: url, max: 1 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.agency_id', $1, true)", [agencyId]);
  const found = await client.query(
    'SELECT id, status, email FROM matrimony.accounts WHERE agency_id = $1 AND ' +
      (accountId ? 'id = $2' : 'email = $2'),
    [agencyId, accountId ?? email],
  );
  const account = found.rows[0];
  if (!account) throw new Error('No such account in this agency');
  if (account.email && account.email !== email)
    throw new Error('That account already has a different email address');
  if (!account.email) {
    await client.query(
      'UPDATE matrimony.accounts SET email = $3 WHERE agency_id = $1 AND id = $2',
      [agencyId, account.id, email],
    );
  }
  await client.query(
    `INSERT INTO matrimony.account_credentials(agency_id, account_id, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (agency_id, account_id)
     DO UPDATE SET password_hash = EXCLUDED.password_hash, password_changed_at = now()`,
    [agencyId, account.id, hash],
  );
  await client.query('COMMIT');
  console.log(`Password set for account ${account.id} (status: ${account.status}).`);
  if (account.status !== 'active') console.log('Note: only an active account can sign in.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
