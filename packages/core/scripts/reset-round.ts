/**
 * reset-round — wipe a PvP round so it can be replayed from scratch.
 *
 * DELETEs every row for the given round from BOTH `pvp_results` (standings) and
 * `pvp_boards` (submitted boards). After this, the round id is empty again:
 * players can resubmit and you can re-close it with run-round.
 *
 * This is DESTRUCTIVE and irreversible. Writing/deleting needs the Supabase
 * SERVICE-ROLE key (it bypasses RLS) — same key run-round uses. Set it in a
 * repo-root `.env` (local) or the SUPABASE_SERVICE_ROLE_KEY env var (CI).
 *
 * A guard is enforced: you must pass --confirm <round> matching the round id,
 * so a stray invocation can't nuke a round. Without the service key the script
 * refuses to run (there is no safe dry-run for a delete — nothing to preview).
 *
 * Run:  npm run reset-round -- <round_id> --confirm <round_id>
 *       e.g. npm run reset-round -- r1 --confirm r1
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Public, publishable anon creds — same as run-round.ts / telemetry.ts.
const SUPABASE_URL = 'https://wvrllhiktnkvbpclmrpq.supabase.co';

const ROUND = process.argv[2];
// Confirmation can be given as `--confirm <round>` (survives the `-w` form) or
// as a bare positional second arg `<round> <round>` (survives npm's flag
// munging through the root wrapper). Either way it must equal ROUND below.
const confirmIdx = process.argv.indexOf('--confirm');
const CONFIRM =
  confirmIdx >= 0
    ? process.argv[confirmIdx + 1]
    : process.argv[3] && !process.argv[3].startsWith('--')
      ? process.argv[3]
      : undefined;

if (!ROUND || ROUND.startsWith('--')) {
  console.error('usage: npm run reset-round -- <round_id> --confirm <round_id>');
  process.exit(1);
}
if (CONFIRM !== ROUND) {
  console.error(
    `Refusing to reset: pass --confirm ${ROUND} to confirm you mean to wipe round "${ROUND}".`
  );
  process.exit(1);
}

/** Minimal .env loader (tsx does not auto-load one). Repo-root .env, KEY=VALUE. */
function serviceKey(): string | undefined {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return process.env.SUPABASE_SERVICE_ROLE_KEY;
  for (const p of ['.env', '../.env', '../../.env']) {
    try {
      const txt = readFileSync(join(process.cwd(), p), 'utf8');
      const m = txt.match(/^\s*SUPABASE_SERVICE_ROLE_KEY\s*=\s*(.+)\s*$/m);
      if (m) return m[1].trim().replace(/^['"]|['"]$/g, '');
    } catch {
      /* no file here — try the next */
    }
  }
  return undefined;
}

/** DELETE every row in `table` for this round; returns how many were removed. */
async function wipe(table: string, key: string): Promise<number> {
  const url = `${SUPABASE_URL}/rest/v1/${table}?round_id=eq.${encodeURIComponent(ROUND)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      // return=representation + count=exact so we can report what was deleted.
      Prefer: 'return=representation,count=exact',
    },
  });
  if (!res.ok) throw new Error(`${table} delete failed: ${res.status} ${await res.text()}`);
  const rows = (await res.json()) as unknown[];
  return Array.isArray(rows) ? rows.length : 0;
}

async function main() {
  const key = serviceKey();
  if (!key) {
    console.error(
      '\nNo SUPABASE_SERVICE_ROLE_KEY found — a reset deletes data and has no dry-run.\n' +
        'Set the key (repo-root .env locally, or the secret in CI) and try again.\n'
    );
    process.exit(1);
  }

  console.log(`\nResetting round "${ROUND}" — deleting standings, then boards…`);
  // Results first (nothing depends on them), then boards.
  const results = await wipe('pvp_results', key);
  const boards = await wipe('pvp_boards', key);
  console.log(
    `Done. Removed ${results} standings row(s) and ${boards} board(s) for round "${ROUND}".\n` +
      'The round is now empty — players can resubmit.\n'
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
