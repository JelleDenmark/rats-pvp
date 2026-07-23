/**
 * run-round — manual PvP round runner / operator override.
 *
 * Given a round id, it: fetches every board submitted for that round from
 * Supabase (public anon read of `pvp_boards`), drops any that fail PvP
 * legality (`validateBoard`/`legalEntrants` in ../src/pvp.ts — the SAME check
 * the client builder uses, so a forged raw-POST to the RPC can't be scored),
 * runs the all-vs-all round-robin (`scoreRound`), and writes the standings to
 * `pvp_results`. On a real write it also marks the round `closed` in
 * `pvp_rounds` (see 2026-07-23-add-pvp-rounds.sql).
 *
 * This is now the OPERATOR OVERRIDE, not the only way a round closes: the
 * automated path is `advance-round.ts` (run on a schedule by
 * .github/workflows/rats-cron.yml), which calls this same logic. Keep this
 * script for a manual close/preview from the phone control panel
 * (rats-control.yml) or a terminal.
 *
 * Reading is public. WRITING needs the Supabase SERVICE-ROLE key (it bypasses
 * RLS) — set it in a local `.env` at the repo root (Jesper only; never commit
 * or ship it):
 *
 *     SUPABASE_SERVICE_ROLE_KEY=eyJ...      # service_role, NOT the anon key
 *
 * Without that key the script runs in DRY-RUN mode: it prints the standings but
 * writes nothing (so it's safe to run for a preview, and testable with no key).
 *
 * Run:  npm run run-round -- <round_id> [--dry]
 */
import { serviceKey } from './lib/service-key';
import { runAndWriteRound, printStandings } from './lib/pvp-round';

const ROUND = process.argv[2];
if (!ROUND) {
  console.error('usage: npm run run-round -- <round_id> [--dry]');
  process.exit(1);
}
// --dry (or a bare `dry` token) forces a preview even when the service key is
// present: compute and print the standings but write nothing (the "status"
// control action). Both spellings are accepted so it survives npm's flag
// munging whether invoked via `-w @wrad/core --` or the root wrapper script.
const DRY = process.argv.slice(3).some((a) => a === '--dry' || a === 'dry');

async function main() {
  console.log(`\nRound ${ROUND} — fetching submitted boards…`);
  const key = DRY ? undefined : serviceKey();

  const { totalSubmitted, rows, dropped, skippedNoOp } = await runAndWriteRound(ROUND, key);
  console.log(`Loaded ${totalSubmitted} submitted board(s), ${dropped.length} dropped as illegal.`);
  for (const d of dropped) console.log(`  - ${d.name} (${d.id}): ${d.reason}`);

  if (skippedNoOp) {
    console.log('Need at least 2 legal boards to run a round.');
    if (key) console.log(`Round ${ROUND} marked closed (nothing to score).`);
    return;
  }

  printStandings(rows);

  if (!key) {
    const why = DRY ? '--dry requested' : 'no SUPABASE_SERVICE_ROLE_KEY found';
    console.log(`\n(DRY RUN — ${why}; nothing written.)\n`);
    return;
  }
  console.log(`\nWrote ${rows.length} rows to pvp_results for round ${ROUND}. Round marked closed.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
