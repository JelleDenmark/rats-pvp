/**
 * Test #1 — pit the REAL leaderboard boards against each other.
 *
 * WRAD persists every ranked player's exact board in the public-read
 * `scores.lineup` jsonb column (units + tiers + per-unit relics + team relics +
 * combatCap). This script pulls the top-N boards of a season straight from that
 * table (the `combined_board` VIEW the app reads omits `lineup`, so we hit
 * `scores` directly) and runs them all against each other through the new
 * symmetric `simulateDuel`.
 *
 * The question it answers: does the current PvE-optimized meta make for
 * INTERESTING PvP — a spread of winners, real counters — or does one board
 * dominate every matchup? That directly informs the PvP roster/counter design.
 *
 * Run:  npm run leaderboard-duels            (from repo root)
 *       npm run leaderboard-duels -- 2026-07-20 12
 *   args: [seasonId] [topN]
 *
 * No auth beyond the public anon key (same one the shipped client uses). All
 * reads, no writes.
 */
import { UNIT_DEFS, type Lineup } from '../src/data/units';
import { simulateDuel } from '../src/duel';

// Public, publishable anon credentials — copied from packages/app/src/telemetry.ts.
const SUPABASE_URL = 'https://wvrllhiktnkvbpclmrpq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_6S2kGgYAI2gRLhfRxXBY3A_E_mIgpAi';

const SEASON = process.argv[2] ?? '2026-07-20';
const TOP_N = Number(process.argv[3] ?? 12);

interface ScoreRow {
  name: string;
  device_id: string;
  depth: number;
  lineup: Lineup & { rideHour?: number };
}

interface Board {
  name: string;
  depth: number;
  lineup: Lineup;
}

async function fetchTopBoards(season: string, limit: number): Promise<ScoreRow[]> {
  const q = new URLSearchParams({
    season_id: `eq.${season}`,
    select: 'name,device_id,depth,lineup',
    order: 'depth.desc,day.asc',
    limit: String(limit),
  });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/scores?${q}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`scores fetch failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as ScoreRow[];
}

/** A board is playable only if every unit def exists in the current roster —
 * a retired/renamed unit would crash `instantiate`. Unknown *relics* are
 * harmless (the sim filters them), so we only gate on defIds. */
function playable(row: ScoreRow): Board | null {
  const units = row.lineup?.units ?? [];
  const unknown = units.map((u) => u.defId).filter((id) => !UNIT_DEFS[id]);
  if (unknown.length > 0) return null;
  return {
    name: row.name,
    depth: row.depth,
    lineup: {
      units,
      teamRelicIds: row.lineup.teamRelicIds,
      combatCap: row.lineup.combatCap,
      timeOfDay: row.lineup.timeOfDay,
    },
  };
}

function pad(s: string, n: number): string {
  const t = [...s].slice(0, n).join('');
  return t + ' '.repeat(Math.max(0, n - t.length));
}

async function main() {
  console.log(`\nSeason ${SEASON} — fetching top ${TOP_N} boards…`);
  const rows = await fetchTopBoards(SEASON, TOP_N);
  const boards: Board[] = [];
  let skipped = 0;
  for (const r of rows) {
    const b = playable(r);
    if (b) boards.push(b);
    else skipped++;
  }
  console.log(`Loaded ${boards.length} playable boards (${skipped} skipped for retired units).\n`);
  if (boards.length < 2) {
    console.log('Need at least 2 playable boards to duel.');
    return;
  }

  const n = boards.length;
  const wins = new Array(n).fill(0);
  const losses = new Array(n).fill(0);
  const draws = new Array(n).fill(0);
  // grid[i][j] = result of board i (as side A) vs board j (as side B): 'W'/'L'/'D'
  const grid: string[][] = Array.from({ length: n }, () => new Array(n).fill('·'));
  let seatingSensitive = 0;
  let totalGames = 0;
  let totalDraws = 0;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const w = simulateDuel(boards[i].lineup, boards[j].lineup).result.winner; // i is side A
      grid[i][j] = w === 'a' ? 'W' : w === 'b' ? 'L' : 'D';
      totalGames++;
      if (w === 'a') wins[i]++;
      else if (w === 'b') losses[i]++;
      else {
        draws[i]++;
        totalDraws++;
      }
      // Seating check: compare i-vs-j (this game) with the j-vs-i game's verdict
      // once we reach it. Detect disagreement when both orientations are done.
      if (i < j) {
        const back = simulateDuel(boards[j].lineup, boards[i].lineup).result.winner; // j is side A
        // i should win iff (i beats j as A) and (j loses to i as A i.e. back==='b')
        const iWinsFwd = w === 'a';
        const iWinsBack = back === 'b';
        if (w !== 'draw' && back !== 'draw' && iWinsFwd !== iWinsBack) seatingSensitive++;
      }
    }
  }

  // Standings by win count (then fewest losses).
  const order = [...boards.keys()].sort((a, b) => wins[b] - wins[a] || losses[a] - losses[b]);

  console.log('PvP standings (round-robin, each board plays every other as side A):');
  console.log(`  ${pad('#', 3)}${pad('board', 22)}${pad('PvE', 5)}${pad('W', 4)}${pad('L', 4)}${pad('D', 4)}win%`);
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const games = wins[i] + losses[i] + draws[i];
    const wr = games ? Math.round((wins[i] / games) * 100) : 0;
    console.log(
      `  ${pad(String(k + 1), 3)}${pad(boards[i].name, 22)}${pad('d' + boards[i].depth, 5)}${pad(String(wins[i]), 4)}${pad(String(losses[i]), 4)}${pad(String(draws[i]), 4)}${wr}%`
    );
  }

  console.log('\nWin matrix (row = side A vs column = side B):');
  const header = '     ' + order.map((_, k) => pad(String(k + 1), 3)).join('');
  console.log(header);
  for (let ri = 0; ri < order.length; ri++) {
    const i = order[ri];
    const cells = order.map((j) => (i === j ? ' - ' : ` ${grid[i][j]} `)).join('');
    console.log(`  ${pad(String(ri + 1), 3)}${cells}  ${pad(boards[i].name, 18)}`);
  }

  const topWr = Math.max(...boards.map((_, i) => (wins[i] + losses[i] + draws[i] ? wins[i] / (wins[i] + losses[i] + draws[i]) : 0)));
  console.log('\nSummary:');
  console.log(`  games played:        ${totalGames}`);
  console.log(`  draw rate:           ${Math.round((totalDraws / totalGames) * 100)}%`);
  console.log(`  best board win-rate: ${Math.round(topWr * 100)}%  (dominance flag if >60%)`);
  console.log(`  seating-sensitive matchups (verdict flips with seat): ${seatingSensitive}`);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
