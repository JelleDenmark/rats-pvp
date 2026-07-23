/**
 * reset-round — wipe a PvP round so it can be replayed from scratch.
 *
 * DELETEs every row for the given round from BOTH `pvp_results` (standings) and
 * `pvp_boards` (submitted boards), then re-opens the round in `pvp_rounds`
 * (status back to 'open', a fresh closes_at DEFAULT_ROUND_HOURS from now).
 * That reopen step matters as of the round-lifecycle migration
 * (2026-07-23-add-pvp-rounds.sql): without it the round would stay marked
 * 'closed' and `submit_pvp_board` would reject every resubmission.
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
import { serviceKey } from './lib/service-key';
import { SUPABASE_URL, DEFAULT_ROUND_HOURS } from './lib/pvp-round';

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

/** Upsert the round back to 'open' with a fresh close time. */
async function reopenRound(key: string): Promise<string> {
  const opensAt = new Date();
  const closesAt = new Date(opensAt.getTime() + DEFAULT_ROUND_HOURS * 60 * 60 * 1000);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/pvp_rounds?on_conflict=round_id`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([
      { round_id: ROUND, opens_at: opensAt.toISOString(), closes_at: closesAt.toISOString(), status: 'open' },
    ]),
  });
  if (!res.ok) throw new Error(`pvp_rounds reopen failed: ${res.status} ${await res.text()}`);
  return closesAt.toISOString();
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
  const closesAt = await reopenRound(key);
  console.log(
    `Done. Removed ${results} standings row(s) and ${boards} board(s) for round "${ROUND}".\n` +
      `Round is OPEN again — closes ${closesAt}. Players can resubmit.\n`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
