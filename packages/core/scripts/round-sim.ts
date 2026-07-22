/**
 * round-sim — prototype of the first PvP format.
 *
 * The format (v1, as specced by Jesper):
 *   - Every player gets a flat 100 scrap to assemble a board (equalized
 *     economy — no accrual, no snowball; see docs/design/pvp-notes.md).
 *   - Every 2 hours a ROUND fires: every submitted board fights every other
 *     board (all-vs-all round robin).
 *   - Scoring per battle: +1 for each of YOUR units left standing, -1 for each
 *     ENEMY unit left standing. Your round score is the sum across all
 *     opponents. It's zero-sum and margin-sensitive — a decisive stomp is worth
 *     far more than a squeaker.
 *
 * This script simulates one round over a sample population to show how the
 * format behaves: whether the counter triangle actually drives the standings,
 * and how the survivor-margin scoring rewards different archetypes.
 *
 * Each pair plays BOTH seatings (home + away) so seating can't bias the score.
 *
 * Run:  npm run round-sim
 */
import { UNIT_DEFS, type Lineup } from '../src/data/units';
import { simulateDuel } from '../src/duel';

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

  const n = PLAYERS.length;
  const score = new Array(n).fill(0);
  const wins = new Array(n).fill(0);
  const losses = new Array(n).fill(0);
  const draws = new Array(n).fill(0);

  // All-vs-all, each pair home AND away; score = your survivors - their survivors.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (const [a, b] of [
        [i, j],
        [j, i],
      ] as [number, number][]) {
        const r = simulateDuel(PLAYERS[a].lineup, PLAYERS[b].lineup).result;
        const marginA = r.survivorsA.length - r.survivorsB.length;
        score[a] += marginA;
        score[b] -= marginA;
        if (r.winner === 'a') {
          wins[a]++; losses[b]++;
        } else if (r.winner === 'b') {
          wins[b]++; losses[a]++;
        } else {
          draws[a]++; draws[b]++;
        }
      }
    }
  }

  const order = [...PLAYERS.keys()].sort((a, b) => score[b] - score[a]);
  console.log('\nRound standings (score = surviving allies − surviving enemies, summed):');
  console.log(`  ${pad('#', 3)}${pad('player', 22)}${pad('score', 7)}${pad('W', 4)}${pad('L', 4)}${pad('D', 4)}`);
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    console.log(
      `  ${pad(String(k + 1), 3)}${pad(PLAYERS[i].name, 22)}${pad((score[i] >= 0 ? '+' : '') + score[i], 7)}${pad(String(wins[i]), 4)}${pad(String(losses[i]), 4)}${pad(String(draws[i]), 4)}`
    );
  }
  console.log('\n  (this lobby is skewed toward WALL; watch where its counter, BRUISER, lands)\n');
}

main();
