/**
 * PvP round-runner I/O — the Supabase REST glue shared by the manual
 * `run-round`/`reset-round` scripts (the rats-control.yml operator panel) and
 * the cron `advance-round` entry point (rats-cron.yml). Scoring itself is
 * NOT here — it's `scoreRound`/`legalEntrants` in `../../src/pvp.ts`, the
 * single source of truth also usable by offline tooling (round-sim.ts).
 *
 * All three scripts talk directly to the PostgREST REST API via `fetch` (no
 * supabase-js dependency), same as the app client (packages/app/src/telemetry.ts).
 */
import { legalEntrants, scoreRound, type Lineup, type PvpStanding } from '../../src';

// Public, publishable anon creds — same as packages/app/src/telemetry.ts.
export const SUPABASE_URL = 'https://wvrllhiktnkvbpclmrpq.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_6S2kGgYAI2gRLhfRxXBY3A_E_mIgpAi';

/** Default round length advance-round.ts uses when it opens the next round. */
export const DEFAULT_ROUND_HOURS = 2;

export interface BoardRow {
  device_id: string;
  name: string;
  lineup: Lineup;
}

export interface RoundRow {
  round_id: string;
  opens_at: string;
  closes_at: string;
  status: 'open' | 'scoring' | 'closed';
}

function anonHeaders(): Record<string, string> {
  return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
}
function serviceHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}

export async function fetchBoards(round: string): Promise<BoardRow[]> {
  const url =
    `${SUPABASE_URL}/rest/v1/pvp_boards?round_id=eq.${encodeURIComponent(round)}` +
    `&select=device_id,name,lineup`;
  const res = await fetch(url, { headers: anonHeaders() });
  if (!res.ok) throw new Error(`pvp_boards fetch failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as BoardRow[];
}

/** Rows matching a PostgREST filter query string, e.g. `status=eq.open&select=...`. */
export async function fetchRounds(filter: string): Promise<RoundRow[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/pvp_rounds?${filter}`, { headers: anonHeaders() });
  if (!res.ok) throw new Error(`pvp_rounds fetch failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as RoundRow[];
}

export async function insertRound(
  row: { round_id: string; opens_at: string; closes_at: string; status: 'open' },
  key: string
): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/pvp_rounds`, {
    method: 'POST',
    headers: serviceHeaders(key, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`pvp_rounds insert failed: ${res.status} ${await res.text()}`);
}

export async function patchRoundStatus(round: string, status: RoundRow['status'], key: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/pvp_rounds?round_id=eq.${encodeURIComponent(round)}`, {
    method: 'PATCH',
    headers: serviceHeaders(key, { 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify({ status }),
  });
  if (!res.ok) throw new Error(`pvp_rounds status patch failed: ${res.status} ${await res.text()}`);
}

async function writeResults(round: string, rows: PvpStanding[], key: string): Promise<void> {
  const body = rows.map((r) => ({
    round_id: round,
    device_id: r.id,
    name: r.name,
    score: r.score,
    margin: r.margin,
    wins: r.wins,
    losses: r.losses,
    draws: r.draws,
    rank: r.rank,
  }));
  const res = await fetch(`${SUPABASE_URL}/rest/v1/pvp_results?on_conflict=round_id,device_id`, {
    method: 'POST',
    headers: serviceHeaders(key, {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`pvp_results write failed: ${res.status} ${await res.text()}`);
}

function pad(s: string, n: number) {
  const t = [...s].slice(0, n).join('');
  return t + ' '.repeat(Math.max(0, n - t.length));
}

export function printStandings(rows: PvpStanding[]): void {
  console.log('\nStandings (points: win 3 / draw 1 / loss 0; margin breaks ties):');
  console.log(
    `  ${pad('#', 3)}${pad('player', 22)}${pad('pts', 5)}${pad('W', 4)}${pad('L', 4)}${pad('D', 4)}${pad('margin', 7)}`
  );
  for (const r of rows) {
    console.log(
      `  ${pad(String(r.rank), 3)}${pad(r.name, 22)}${pad(String(r.score), 5)}${pad(String(r.wins), 4)}${pad(String(r.losses), 4)}${pad(String(r.draws), 4)}${pad((r.margin >= 0 ? '+' : '') + r.margin, 7)}`
    );
  }
}

export interface RunRoundOutcome {
  totalSubmitted: number;
  rows: PvpStanding[];
  dropped: { id: string; name: string; reason: string }[];
  /** True when fewer than 2 legal boards were available — nothing was scored. */
  skippedNoOp: boolean;
}

/**
 * Fetches every board submitted for `round`, drops illegal ones
 * (`legalEntrants` — shared with the client builder's `validateBoard`), scores
 * the rest (`scoreRound`), and — only when a service-role `key` is given —
 * writes `pvp_results` and marks the round `scoring` then `closed`.
 *
 * With `key` undefined this is a pure preview: it fetches and computes but
 * writes nothing (the `--dry` / no-service-key path both manual scripts and
 * the cron entry point share).
 */
export async function runAndWriteRound(round: string, key: string | undefined): Promise<RunRoundOutcome> {
  const all = await fetchBoards(round);
  const { entrants, dropped } = legalEntrants(
    all.map((b) => ({ id: b.device_id, name: b.name, lineup: b.lineup }))
  );

  if (entrants.length < 2) {
    if (key) await patchRoundStatus(round, 'closed', key);
    return { totalSubmitted: all.length, rows: [], dropped, skippedNoOp: true };
  }

  if (key) await patchRoundStatus(round, 'scoring', key);
  const rows = scoreRound(entrants);
  if (key) {
    await writeResults(round, rows, key);
    await patchRoundStatus(round, 'closed', key);
  }
  return { totalSubmitted: all.length, rows, dropped, skippedNoOp: false };
}
