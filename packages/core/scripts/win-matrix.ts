/**
 * win-matrix — board-vs-board PvP balance tool (adapts combo-matrix.ts's
 * pairwise idea to the symmetric `simulateDuel`).
 *
 * A duel is fully deterministic in the two lineups (no seed to average over),
 * so each matchup is played in BOTH seatings and the verdict is seat-neutral:
 *   - one board wins both seatings          -> decisive win for that board
 *   - the two seatings disagree             -> 'split' (seating-sensitive)
 *   - both seatings draw                    -> draw
 *
 * It then hunts for the thing PvP actually needs: a NON-TRANSITIVE cycle
 * (A beats B, B beats C, C beats A). Test #1 showed the PvE meta has none — it's
 * a straight power ladder — so this tool is how we'll verify a designed
 * swarm/tank/sniper triangle really holds.
 *
 * The role boards below are PROVISIONAL validation fixtures (built from existing
 * units), NOT the committed PvP roster — they exist to exercise the tool.
 *
 * Run:  npm run win-matrix
 *       npm run win-matrix -- --two-lane   (Milestone B2 analysis: does the
 *       counter triangle still hold under two-row parallel lanes, and how
 *       often does the "cross-lane stranding" edge case actually occur for
 *       these board shapes? See docs/design/pvp-notes.md / the B2 plan.)
 */
import type { Lineup } from '../src/data/units';
import { simulateDuel } from '../src/duel';

const TWO_LANE = process.argv.includes('--two-lane');

interface Board {
  name: string;
  lineup: Lineup;
}

const u = (defId: string, tier = 1, relicIds: string[] = []) => ({ defId, tier, relicIds });

// ---- FIRST-PASS PvP roster: a relic-free counter triangle ------------------
// WALL > THORN > BRUISER > WALL, from three dedicated PvP units (data/units.ts,
// `pvpOnly`), tier 1, 6 seats. Relic-free — the counter mechanics are INNATE
// (armor / reflect / lifesteal). Verified here: every board 1-1, 0 draws, 0
// seating-sensitive; the mirror-fairness test proves each board draws itself.
//
// Why these three (see docs/design/pvp-notes.md for the full derivation):
//   * pure stats can't make rock-paper-scissors — non-transitivity NEEDS a
//     conditional mechanic;
//   * cleave/execute pierce works but cleave breaks mirror-fairness (its
//     overkill resolves side-A-first), so it's out;
//   * armor + reflect + lifesteal are all seat-safe and form a clean cycle.
//
// The logic:
//   Wall > Thorn      Plate-Rat's armor floors Bramble-Rat's tiny attack.
//   Thorn > Bruiser   Bramble-Rat's reflect outpaces Gorge-Rat's lifesteal.
//   Bruiser > Wall    Gorge-Rat out-sustains Plate-Rat's armor-floored chip.
const roleBoard = (defId: string, name: string): Board => ({
  name,
  lineup: { units: Array.from({ length: 6 }, () => u(defId)) },
});
const BOARDS: Board[] = [
  roleBoard('plate-rat', 'WALL'),
  roleBoard('bramble-rat', 'THORN'),
  roleBoard('gorge-rat', 'BRUISER'),
  // Issue #1: imported 2nd-per-role picks (see data/units.ts) — checked
  // in-role against the originals and cross-role against every other role
  // so a strong horde can't dodge the triangle by picking the "alt" body.
  roleBoard('dire-rat-pvp', 'WALL-2'),
  roleBoard('steel-whisker-pvp', 'THORN-2'),
  roleBoard('grave-leech-pvp', 'BRUISER-2'),
  // Issue #1 follow-up: Press-Kin — a 4th archetype OUTSIDE the triangle (pure
  // buffAdjacent stats, no counter mechanic). Checked here to confirm it lands
  // mid-table (viable, not dominant, not a dead pick) without disturbing the
  // WALL > THORN > BRUISER cycle. See data/units.ts + docs/design/pvp-notes.md.
  roleBoard('press-kin-pvp', 'PRESS'),
];

// ---------------------------------------------------------------------------

type Verdict = 'a' | 'b' | 'draw' | 'split';

/** Neither side was wiped — the duel was decided by the health/attack
 * tiebreak rather than an actual fight. Only possible under `--two-lane`
 * (see the B2 plan's "cross-lane stranding" finding); always false
 * single-lane, since one whole side is wiped almost every duel. */
function isStranded(result: { survivorsA: unknown[]; survivorsB: unknown[] }): boolean {
  return result.survivorsA.length > 0 && result.survivorsB.length > 0;
}

/** Seat-neutral matchup: play both seatings, collapse to a single verdict.
 * Also reports whether either seating stranded (see `isStranded`) so callers
 * can measure how often that edge case actually bites for real board shapes. */
function matchup(a: Board, b: Board): { verdict: Verdict; strandedCount: number } {
  const r1 = simulateDuel(a.lineup, b.lineup, { twoLane: TWO_LANE }).result; // a seated first
  const r2 = simulateDuel(b.lineup, a.lineup, { twoLane: TWO_LANE }).result; // b seated first
  const g1 = r1.winner;
  const g2 = r2.winner;
  const aWins = g1 === 'a' && g2 === 'b';
  const bWins = g1 === 'b' && g2 === 'a';
  const strandedCount = (isStranded(r1) ? 1 : 0) + (isStranded(r2) ? 1 : 0);
  if (aWins) return { verdict: 'a', strandedCount };
  if (bWins) return { verdict: 'b', strandedCount };
  if (g1 === 'draw' && g2 === 'draw') return { verdict: 'draw', strandedCount };
  return { verdict: 'split', strandedCount };
}

function pad(s: string, n: number): string {
  const t = [...s].slice(0, n).join('');
  return t + ' '.repeat(Math.max(0, n - t.length));
}

function run(boards: Board[]) {
  const n = boards.length;
  // beats[i][j] = i decisively beats j (seat-neutral).
  const beats: boolean[][] = Array.from({ length: n }, () => new Array(n).fill(false));
  const cell: string[][] = Array.from({ length: n }, () => new Array(n).fill(' -'));
  const wins = new Array(n).fill(0);
  const losses = new Array(n).fill(0);
  const draws = new Array(n).fill(0);
  const splits = new Array(n).fill(0);
  let splitCount = 0;
  let strandedTotal = 0;
  let duelsPlayed = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const { verdict: v, strandedCount } = matchup(boards[i], boards[j]);
      strandedTotal += strandedCount;
      duelsPlayed += 2; // both seatings
      if (v === 'a') {
        beats[i][j] = true;
        wins[i]++; losses[j]++;
        cell[i][j] = ' W'; cell[j][i] = ' L';
      } else if (v === 'b') {
        beats[j][i] = true;
        wins[j]++; losses[i]++;
        cell[i][j] = ' L'; cell[j][i] = ' W';
      } else if (v === 'draw') {
        draws[i]++; draws[j]++;
        cell[i][j] = ' D'; cell[j][i] = ' D';
      } else {
        splits[i]++; splits[j]++; splitCount++;
        cell[i][j] = ' S'; cell[j][i] = ' S';
      }
    }
  }

  console.log(`\nMode: ${TWO_LANE ? 'TWO-LANE (--two-lane)' : 'single-lane (today\'s live format)'}`);
  console.log('\nBoards:');
  boards.forEach((b, i) =>
    console.log(`  ${i + 1}. ${pad(b.name, 8)} [${b.lineup.units.map((x) => x.defId).join(', ')}]`)
  );

  console.log('\nSeat-neutral matchup matrix (row vs column):');
  console.log('      ' + boards.map((_, j) => pad(String(j + 1), 3)).join(''));
  for (let i = 0; i < n; i++) {
    console.log(`  ${pad(String(i + 1), 3)} ` + boards.map((_, j) => (i === j ? '  -' : ` ${cell[i][j].trim()} `)).join('') + `  ${boards[i].name}`);
  }

  console.log('\nStandings:');
  const order = [...boards.keys()].sort((a, b) => wins[b] - wins[a] || losses[a] - losses[b]);
  console.log(`  ${pad('board', 8)} ${pad('W', 3)}${pad('L', 3)}${pad('D', 3)}${pad('split', 6)}`);
  for (const i of order) {
    console.log(`  ${pad(boards[i].name, 8)} ${pad(String(wins[i]), 3)}${pad(String(losses[i]), 3)}${pad(String(draws[i]), 3)}${pad(String(splits[i]), 6)}`);
  }

  // Non-transitive cycle hunt: any directed 3-cycle among decisive matchups.
  const cycles: string[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      for (let k = 0; k < n; k++)
        if (i !== j && j !== k && i !== k && beats[i][j] && beats[j][k] && beats[k][i]) {
          // Canonicalize (smallest index first) to print each cycle once.
          if (i < j && i < k)
            cycles.push(`${boards[i].name} > ${boards[j].name} > ${boards[k].name} > ${boards[i].name}`);
        }

  console.log('\nNon-transitivity:');
  if (cycles.length === 0) {
    console.log('  none — this set is a transitive power ladder (no rock-paper-scissors).');
  } else {
    console.log(`  ${cycles.length} counter cycle(s) found:`);
    for (const c of cycles) console.log(`    ${c}`);
  }
  console.log(`\n  seating-sensitive matchups: ${splitCount}`);
  if (TWO_LANE) {
    const pct = ((strandedTotal / duelsPlayed) * 100).toFixed(1);
    console.log(
      `  cross-lane stranding: ${strandedTotal}/${duelsPlayed} duels (${pct}%) resolved by the ` +
        `health/attack tiebreak rather than a wipe (see the B2 plan's "stranding" finding)`
    );
  }
  console.log('');
}

run(BOARDS);

// ---- Two-lane-only supplementary analysis ----------------------------------
// The mono-stack BOARDS above are structurally incapable of exercising
// cross-lane stranding: every unit in a lane is identical to its own board's
// other lane, so both lanes always decide the same way — confirmed empirically
// (0/42 stranded above). Real players build MIXED boards (different roles
// front vs back), which is exactly the shape that can strand. This half-and-half
// fixture (3 of one role + 3 of another, respecting the ceil(6/2)=3 lane split)
// gives --two-lane a meaningful stranding measurement and a second look at
// whether the counter triangle holds when lane composition actually varies.
if (TWO_LANE) {
  const halfAndHalf = (defIdA: string, defIdB: string, name: string): Board => ({
    name,
    lineup: { units: [...Array.from({ length: 3 }, () => u(defIdA)), ...Array.from({ length: 3 }, () => u(defIdB))] },
  });
  const MIXED_BOARDS: Board[] = [
    halfAndHalf('plate-rat', 'bramble-rat', 'WAL/THN'),
    halfAndHalf('bramble-rat', 'gorge-rat', 'THN/BRS'),
    halfAndHalf('gorge-rat', 'plate-rat', 'BRS/WAL'),
    halfAndHalf('plate-rat', 'press-kin-pvp', 'WAL/PRS'),
    halfAndHalf('bramble-rat', 'press-kin-pvp', 'THN/PRS'),
    halfAndHalf('gorge-rat', 'press-kin-pvp', 'BRS/PRS'),
  ];
  console.log('\n' + '='.repeat(60));
  console.log('SUPPLEMENTARY: mixed-composition boards (two-lane only)');
  console.log('='.repeat(60));
  run(MIXED_BOARDS);
}
