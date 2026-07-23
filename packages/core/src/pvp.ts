// Rats PvP — shared rules for a legal board (Milestone A).
//
// Single source of truth for the PvP budget, board cap, roster, and unit cost,
// plus `validateBoard` — the legality check the client builder and the
// server-side round runner BOTH use. The client only ever submits a *board*;
// the runner recomputes every duel deterministically, so results are already
// server-authoritative. The remaining cheat surface is a forged board POSTed
// straight to the `submit_pvp_board` RPC (over-budget, non-roster/PvE units,
// tier > 1, relics). `validateBoard` is what the runner enforces to drop such
// boards from standings — see docs/design/pvp-notes.md and run-round.ts.

import { UNIT_DEFS, type Lineup } from './data/units';
import { simulateDuel } from './duel';

/** Flat, equalized build budget every player gets each round. */
export const PVP_BUDGET = 100;

/** Max units a PvP board may field. */
export const PVP_BOARD_CAP = 8;

export type PvpRole = 'WALL' | 'THORN' | 'BRUISER' | 'SUPPORT';

export interface PvpRosterEntry {
  defId: string;
  role: PvpRole;
  /** One-line builder hint describing the unit's counter identity. */
  blurb: string;
}

/**
 * The ordered PvP roster shown in the builder. The `pvpOnly` flag on the
 * `UnitDef` (not this list) is the authoritative legality gate — `validateBoard`
 * accepts any `pvpOnly` unit — but this list carries the UI ordering and the
 * role/blurb metadata that `UnitDef` doesn't. Keep it in sync as the roster
 * grows (Milestone E).
 */
export const PVP_ROSTER: readonly PvpRosterEntry[] = [
  { defId: 'plate-rat', role: 'WALL', blurb: 'armor — beats THORN' },
  { defId: 'bramble-rat', role: 'THORN', blurb: 'reflect — beats BRUISER' },
  { defId: 'gorge-rat', role: 'BRUISER', blurb: 'lifesteal — beats WALL' },
  { defId: 'dire-rat-pvp', role: 'WALL', blurb: 'softer armor, more health — beats THORN' },
  { defId: 'steel-whisker-pvp', role: 'THORN', blurb: 'armor + reflect — beats BRUISER' },
  { defId: 'grave-leech-pvp', role: 'BRUISER', blurb: 'glass-cannon lifesteal — beats WALL' },
  { defId: 'press-kin-pvp', role: 'SUPPORT', blurb: 'buffs neighbours +2/+2 — folds to THORN' },
];

/**
 * Scrap cost of a unit at a given tier. PvP is tier 1 today, but cost is
 * tier-scaled (`3^(tier-1)`, the WRAD power curve) so budget accounting stays
 * correct if merging is ever added — a tier-3 unit would blow the budget rather
 * than sneak in cheap.
 */
export function pvpUnitCost(defId: string, tier = 1): number {
  const base = UNIT_DEFS[defId]?.cost ?? 0;
  return base * 3 ** (tier - 1);
}

export interface BoardValidation {
  ok: boolean;
  /** Human-readable reason when `ok` is false (for UX + runner logs). */
  reason?: string;
}

/**
 * Is this a legal PvP board? Enforced authoritatively by the round runner so a
 * forged submission can't be scored; also used by the client for friendly
 * pre-submit feedback. Rejects: empty; over cap; unknown or non-`pvpOnly`
 * units; tier != 1; any relics (unit or team); over budget.
 */
export function validateBoard(lineup: Lineup): BoardValidation {
  const units = lineup?.units ?? [];
  if (units.length === 0) return { ok: false, reason: 'empty board' };
  if (units.length > PVP_BOARD_CAP) {
    return { ok: false, reason: `too many units (${units.length} > ${PVP_BOARD_CAP})` };
  }
  if (lineup.teamRelicIds && lineup.teamRelicIds.length > 0) {
    return { ok: false, reason: 'team relics are not allowed in PvP' };
  }

  let total = 0;
  for (const u of units) {
    const def = UNIT_DEFS[u.defId];
    if (!def) return { ok: false, reason: `unknown unit "${u.defId}"` };
    if (!def.pvpOnly) return { ok: false, reason: `unit "${u.defId}" is not a PvP unit` };
    const tier = u.tier ?? 1;
    if (tier !== 1) return { ok: false, reason: `unit "${u.defId}" tier ${tier} not allowed (PvP is tier 1)` };
    if (u.relicIds && u.relicIds.length > 0) {
      return { ok: false, reason: `unit "${u.defId}" carries relics (not allowed in PvP)` };
    }
    total += pvpUnitCost(u.defId, tier);
  }

  if (total > PVP_BUDGET) return { ok: false, reason: `over budget (${total} > ${PVP_BUDGET})` };
  return { ok: true };
}

/**
 * One entrant in a PvP round: an opaque identifier (the Supabase `device_id`
 * in practice, but this type doesn't care), a display name, and the board
 * they submitted.
 */
export interface PvpEntrant {
  id: string;
  name: string;
  lineup: Lineup;
}

export interface DroppedEntrant {
  id: string;
  name: string;
  reason: string;
}

/**
 * Splits entrants into legal boards and illegal ones (with why). The round
 * runner drops the illegal ones from the round-robin entirely — a forged
 * submission (over budget, non-PvP unit, tier > 1, relics) can't be scored,
 * whether it came through the builder or a raw POST to the RPC.
 */
export function legalEntrants(entrants: PvpEntrant[]): {
  entrants: PvpEntrant[];
  dropped: DroppedEntrant[];
} {
  const kept: PvpEntrant[] = [];
  const dropped: DroppedEntrant[] = [];
  for (const e of entrants) {
    const v = validateBoard(e.lineup);
    if (v.ok) kept.push(e);
    else dropped.push({ id: e.id, name: e.name, reason: v.reason ?? 'invalid board' });
  }
  return { entrants: kept, dropped };
}

export interface PvpStanding {
  id: string;
  name: string;
  /** Match points: 3 per win, 1 per draw, 0 per loss. */
  score: number;
  /** Survivor differential (your survivors − theirs), summed — the tiebreak. */
  margin: number;
  wins: number;
  losses: number;
  draws: number;
  /** 1-based standings position. */
  rank: number;
}

/**
 * Scores one PvP round: all-vs-all round robin, every pair playing BOTH
 * seatings (home + away) so seating can't bias the result — `simulateDuel` is
 * deterministic and seat-symmetric (see duel.ts), which is also what lets a
 * server independently reproduce this from the same submitted boards.
 *
 * Scoring is football-style match points (win 3 / draw 1 / loss 0), with the
 * survivor-differential margin as a separate tiebreak so the headline score
 * isn't dominated by a few decisive stomps. This is the single source of
 * truth for PvP round scoring — the live round runner (run-round.ts /
 * advance-round.ts) and the offline balance prototype (round-sim.ts) both
 * call this so they can never drift apart.
 */
export function scoreRound(entrants: PvpEntrant[]): PvpStanding[] {
  const n = entrants.length;
  const wins = new Array(n).fill(0);
  const losses = new Array(n).fill(0);
  const draws = new Array(n).fill(0);
  const margin = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (const [a, b] of [
        [i, j],
        [j, i],
      ] as [number, number][]) {
        const r = simulateDuel(entrants[a].lineup, entrants[b].lineup).result;
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
  const order = [...entrants.keys()].sort((a, b) => points(b) - points(a) || margin[b] - margin[a]);
  return order.map((i, k) => ({
    id: entrants[i].id,
    name: entrants[i].name,
    score: points(i),
    margin: margin[i],
    wins: wins[i],
    losses: losses[i],
    draws: draws[i],
    rank: k + 1,
  }));
}
