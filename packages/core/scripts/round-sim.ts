/**
 * round-sim — prototype of the first PvP format.
 *
 * The format (v1, as specced by Jesper):
 *   - Every player gets a flat 100 scrap to assemble a board (equalized
 *     economy — no accrual, no snowball; see docs/design/pvp-notes.md).
 *   - Every 2 hours a ROUND fires: every submitted board fights every other
 *     board (all-vs-all round robin).
 *   - Scoring: football-style match points — win 3, draw 1, loss 0 — summed
 *     across all opponents. The survivor differential (your survivors − theirs)
 *     is tracked separately as a "goal difference" tiebreak, so the standings
 *     reward winning without a few decisive stomps running away with the round.
 *
 * This script simulates one round over a sample population to show how the
 * format behaves: whether the counter triangle actually drives the standings,
 * and how the survivor-margin scoring rewards different archetypes.
 *
 * Each pair plays BOTH seatings (home + away) so seating can't bias the score.
 *
 * Run:  npm run round-sim
 */
import { UNIT_DEFS, type Lineup, scoreRound } from '../src';

const BUDGET = 100;

interface Player {
  name: string;
  lineup: Lineup;
}

const u = (defId: string, tier = 1) => ({ defId, tier, relicIds: [] as string[] });
/** Effective scrap cost: base cost, ×3 per tier step (3 copies merge up). */
const unitCost = (defId: string, tier = 1) => (UNIT_DEFS[defId]?.cost ?? 0) * 3 ** (tier - 1);
const boardCost = (l: Lineup) => l.units.reduce((s, x) => s + unitCost(x.defId, x.tier ?? 1), 0);

const board = (name: string, ...units: [string, number?][]): Player => ({
  name,
  lineup: { units: units.map(([d, t]) => u(d, t ?? 1)) },
});

// A sample "lobby" for one round. Deliberately SKEWED toward WALL to show the
// metagame: when a counter (WALL) is popular, its counter (BRUISER) should rise.
const PLAYERS: Player[] = [
  board('Wallace (6x wall)', ['plate-rat'], ['plate-rat'], ['plate-rat'], ['plate-rat'], ['plate-rat'], ['plate-rat']),
  board('Bricky (6x wall)', ['plate-rat'], ['plate-rat'], ['plate-rat'], ['plate-rat'], ['plate-rat'], ['plate-rat']),
  board('Rampart (6x wall)', ['plate-rat'], ['plate-rat'], ['plate-rat'], ['plate-rat'], ['plate-rat'], ['plate-rat']),
  board('Prickle (6x thorn)', ['bramble-rat'], ['bramble-rat'], ['bramble-rat'], ['bramble-rat'], ['bramble-rat'], ['bramble-rat']),
  board('Nettle (6x thorn)', ['bramble-rat'], ['bramble-rat'], ['bramble-rat'], ['bramble-rat'], ['bramble-rat'], ['bramble-rat']),
  board('Chomp (6x bruiser)', ['gorge-rat'], ['gorge-rat'], ['gorge-rat'], ['gorge-rat'], ['gorge-rat'], ['gorge-rat']),
  board('Medley (2/2/2 mix)', ['plate-rat'], ['plate-rat'], ['bramble-rat'], ['bramble-rat'], ['gorge-rat'], ['gorge-rat']),
];

function pad(s: string, n: number) {
  const t = [...s].slice(0, n).join('');
  return t + ' '.repeat(Math.max(0, n - t.length));
}

function main() {
  // Budget check.
  console.log(`\nRound lobby (${PLAYERS.length} players, ${BUDGET} scrap each):`);
  for (const p of PLAYERS) {
    const cost = boardCost(p.lineup);
    const flag = cost > BUDGET ? `  !! OVER BUDGET (${cost})` : `  (${cost} scrap)`;
    console.log(`  ${pad(p.name, 22)}${flag}`);
  }

  // Scoring (all-vs-all, each pair home AND away; points win 3 / draw 1 / loss
  // 0, survivor-differential margin as tiebreak) is the SAME `scoreRound` the
  // live round runner uses (run-round.ts / advance-round.ts) — one
  // implementation, so this offline prototype can't drift from production.
  const rows = scoreRound(PLAYERS.map((p) => ({ id: p.name, name: p.name, lineup: p.lineup })));
  console.log('\nRound standings (points: win 3 / draw 1 / loss 0; margin breaks ties):');
  console.log(`  ${pad('#', 3)}${pad('player', 22)}${pad('pts', 5)}${pad('W', 4)}${pad('L', 4)}${pad('D', 4)}${pad('margin', 7)}`);
  for (const r of rows) {
    console.log(
      `  ${pad(String(r.rank), 3)}${pad(r.name, 22)}${pad(String(r.score), 5)}${pad(String(r.wins), 4)}${pad(String(r.losses), 4)}${pad(String(r.draws), 4)}${pad((r.margin >= 0 ? '+' : '') + r.margin, 7)}`
    );
  }
  console.log('\n  (this lobby is skewed toward WALL; watch where its counter, BRUISER, lands)\n');
}

main();
