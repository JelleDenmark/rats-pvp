/**
 * advance-round — the cron entry point (.github/workflows/rats-cron.yml).
 *
 * Closes any round whose closes_at has passed (scoring + writing pvp_results
 * via runAndWriteRound, which also enforces PvP board legality — illegal
 * boards are dropped, not scored) and makes sure exactly one round is open
 * afterward. `run-round.ts` / rats-control.yml remain the manual operator
 * override; this script is what runs the same logic automatically.
 *
 * Idempotent and safe to run early or repeatedly: if nothing is due to close,
 * it just checks that an open round exists (opening the first one — `r1` —
 * on a completely fresh backend, satisfying the migration's "seed the first
 * round" step). Supports --dry: preview only, forces a preview even with a
 * service key present, writes nothing.
 *
 * Run:  npm run advance-round -- [--dry] [--hours <n>]
 *       --hours sets the NEXT round's length (default 2h); has no effect on
 *       rounds already open.
 */
import { serviceKey } from './lib/service-key';
import { fetchRounds, insertRound, runAndWriteRound, printStandings, DEFAULT_ROUND_HOURS } from './lib/pvp-round';

const DRY = process.argv.slice(2).some((a) => a === '--dry' || a === 'dry');
const hoursIdx = process.argv.indexOf('--hours');
const ROUND_HOURS = hoursIdx >= 0 && Number(process.argv[hoursIdx + 1]) > 0 ? Number(process.argv[hoursIdx + 1]) : DEFAULT_ROUND_HOURS;

/** Next round id after the highest existing `r<N>`; `r1` if there are none. */
function nextRoundId(existing: { round_id: string }[]): string {
  const nums = existing
    .map((r) => /^r(\d+)$/.exec(r.round_id))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  return `r${(nums.length ? Math.max(...nums) : 0) + 1}`;
}

async function main() {
  const key = DRY ? undefined : serviceKey();
  const now = new Date().toISOString();

  // 1. Close every round that's due.
  const due = await fetchRounds(`status=eq.open&closes_at=lte.${encodeURIComponent(now)}&select=round_id,opens_at,closes_at,status`);
  for (const round of due) {
    console.log(`\nRound ${round.round_id} closed at ${round.closes_at} — scoring…`);
    const { totalSubmitted, rows, dropped, skippedNoOp } = await runAndWriteRound(round.round_id, key);
    console.log(`Loaded ${totalSubmitted} submitted board(s), ${dropped.length} dropped as illegal.`);
    for (const d of dropped) console.log(`  - ${d.name} (${d.id}): ${d.reason}`);

    if (skippedNoOp) {
      console.log('Fewer than 2 legal boards — nothing scored.');
      continue;
    }
    printStandings(rows);
    console.log(key ? `Wrote ${rows.length} rows to pvp_results.` : '(DRY RUN — nothing written.)');
  }
  if (due.length === 0) console.log('No round is due to close yet.');

  // 2. Make sure exactly one round is open.
  const open = await fetchRounds('status=eq.open&select=round_id,opens_at,closes_at,status');
  if (open.length > 0) {
    console.log(`\nRound(s) already open: ${open.map((r) => r.round_id).join(', ')}. Nothing to open.`);
    return;
  }

  const all = await fetchRounds('select=round_id&order=round_id.desc');
  const roundId = nextRoundId(all);
  const opensAt = new Date();
  const closesAt = new Date(opensAt.getTime() + ROUND_HOURS * 60 * 60 * 1000);
  console.log(`\nOpening round ${roundId} — closes ${closesAt.toISOString()} (${ROUND_HOURS}h from now).`);
  if (!key) {
    console.log('(DRY RUN — nothing written.)');
    return;
  }
  await insertRound({ round_id: roundId, opens_at: opensAt.toISOString(), closes_at: closesAt.toISOString(), status: 'open' }, key);
  console.log(`Round ${roundId} is now open.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
