/**
 * run-round — the manual PvP round runner for the lean first playtest.
 *
 * Given a round id, it: fetches every board submitted for that round from
 * Supabase (public anon read of `pvp_boards`), runs the all-vs-all survivor-
 * margin scoring from round-sim.ts, and writes the standings to `pvp_results`.
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
 * Run:  npm run run-round -- <round_id>          e.g. 2026-07-22-r1
 *       (dev-channel rounds are prefixed dev- by the client; pass the full id)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UNIT_DEFS, type Lineup } from '../src/data/units';
import { simulateDuel } from '../src/duel';

// Public, publishable anon creds — same as packages/app/src/telemetry.ts.
const SUPABASE_URL = 'https://wvrllhiktnkvbpclmrpq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_6S2kGgYAI2gRLhfRxXBY3A_E_mIgpAi';

const ROUND = process.argv[2];
if (!ROUND) {
  console.error('usage: npm run run-round -- <round_id>');
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

interface BoardRow {
  device_id: string;
  name: string;
  lineup: Lineup;
}

async function fetchBoards(round: string): Promise<BoardRow[]> {
  const url =
    `${SUPABASE_URL}/rest/v1/pvp_boards?round_id=eq.${encodeURIComponent(round)}` +
    `&select=device_id,name,lineup`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error(`pvp_boards fetch failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as BoardRow[];
}

/** Skip a board that references a unit not in the current roster (would crash
 * instantiate). Unknown relics are harmless — the sim filters them. */
function playable(b: BoardRow): boolean {
  const units = b.lineup?.units ?? [];
  return units.length > 0 && units.every((u) => UNIT_DEFS[u.defId]);
}

async function writeResults(rows: object[], key: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/pvp_results?on_conflict=round_id,device_id`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`pvp_results write failed: ${res.status} ${await res.text()}`);
}

function pad(s: string, n: number) {
  const t = [...s].slice(0, n).join('');
  return t + ' '.repeat(Math.max(0, n - t.length));
}

async function main() {
  console.log(`\nRound ${ROUND} — fetching submitted boards…`);
  const all = await fetchBoards(ROUND);
  const boards = all.filter(playable);
  console.log(`Loaded ${boards.length} playable boards (${all.length - boards.length} skipped).`);
  if (boards.length < 2) {
    console.log('Need at least 2 boards to run a round.');
    return;
  }

  const n = boards.length;
  const wins = new Array(n).fill(0);
  const losses = new Array(n).fill(0);
  const draws = new Array(n).fill(0);
  const margin = new Array(n).fill(0); // survivor differential (tiebreak only)

  // All-vs-all, home + away. Points: win 3, draw 1, loss 0. Margin (your
  // survivors − theirs) is tracked separately as the "goal difference" tiebreak
  // so the headline score isn't dominated by a few decisive stomps.
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (const [a, b] of [
        [i, j],
        [j, i],
      ] as [number, number][]) {
        const r = simulateDuel(boards[a].lineup, boards[b].lineup).result;
        const marginA = r.survivorsA.length - r.survivorsB.length;
        margin[a] += marginA;
        margin[b] -= marginA;
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

  const points = (i: number) => wins[i] * 3 + draws[i];
  const order = [...boards.keys()].sort((a, b) => points(b) - points(a) || margin[b] - margin[a]);
  console.log('\nStandings (points: win 3 / draw 1 / loss 0; margin breaks ties):');
  console.log(`  ${pad('#', 3)}${pad('player', 22)}${pad('pts', 5)}${pad('W', 4)}${pad('L', 4)}${pad('D', 4)}${pad('margin', 7)}`);
  const rows = order.map((i, k) => {
    console.log(
      `  ${pad(String(k + 1), 3)}${pad(boards[i].name, 22)}${pad(String(points(i)), 5)}${pad(String(wins[i]), 4)}${pad(String(losses[i]), 4)}${pad(String(draws[i]), 4)}${pad((margin[i] >= 0 ? '+' : '') + margin[i], 7)}`
    );
    return {
      round_id: ROUND,
      device_id: boards[i].device_id,
      name: boards[i].name,
      score: points(i),
      margin: margin[i],
      wins: wins[i],
      losses: losses[i],
      draws: draws[i],
      rank: k + 1,
    };
  });

  const key = serviceKey();
  if (!key) {
    console.log('\n(DRY RUN — no SUPABASE_SERVICE_ROLE_KEY found; nothing written.)\n');
    return;
  }
  await writeResults(rows, key);
  console.log(`\nWrote ${rows.length} rows to pvp_results for round ${ROUND}.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
